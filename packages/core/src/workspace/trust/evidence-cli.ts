/**
 * `chant workspace evidence sign|verify` (#2553): runner evidence over the
 * records a kind locates, in a DSSE envelope. See ./evidence.ts.
 *
 * `sign` runs in CI or in a service, with a runner key the policy at base
 * lists. It refuses a key the signers file lists: evidence is a machine's
 * statement, and a developer's key cannot make one. `verify` needs no
 * network and no key, only the envelope and the repository.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatError, formatSuccess } from "../../cli/format";
import type { CommandContext } from "../../cli/registry";
import { gitRevisionSource, gitRoot } from "../record-source";
import { loadRecordKind, readRecords } from "../records";
import { loadRunnerKey, type DsseEnvelope } from "./dsse";
import { buildStatement, signEvidence, verifyEvidence, type EvidenceStatement } from "./evidence";
import { policyAtBase, resolveBase } from "./provenance";

const USAGE =
  "chant workspace evidence sign --kind <kind file> --key <runner key.pem> --check-id <id> [--claim <file>] [--environment <file>] [--at <rev>] [--base <rev>] [--output <file>]\n" +
  "  chant workspace evidence verify --envelope <file> [--at <rev>] [--base <rev>] [--json]";

function fail(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return 1;
}

function commitOf(repo: string, rev: string): string | undefined {
  const b = resolveBase(repo, rev);
  return b.commit ?? undefined;
}

export async function runWorkspaceEvidence(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const repo = gitRoot(process.cwd());
  if (!repo) return fail("runner evidence is bound to git commits, and this directory is not in a git repository");
  const sub = args.extraPositional;
  if (sub === "sign") return sign(ctx, repo);
  if (sub === "verify") return verify(ctx, repo);
  return fail(sub ? `Unknown evidence subcommand: ${sub}` : "chant workspace evidence needs sign or verify");
}

export interface SignRequest {
  repo: string;
  /** The kind file, resolved against `cwd`. */
  kind: string;
  cwd: string;
  keyPem: string;
  checkId: string;
  at?: string;
  base?: string;
  claim?: Buffer;
  environment?: Buffer;
}

/**
 * Build and sign evidence, or say why not. Refuses a key the signers file
 * lists, and a key the policy at base does not list as a runner.
 */
export async function signRecordsEvidence(req: SignRequest): Promise<{ envelope: DsseEnvelope; statement: EvidenceStatement; runner: string } | { error: string }> {
  const { repo } = req;
  const at = commitOf(repo, req.at ?? "HEAD");
  if (!at) return { error: `--at ${req.at ?? "HEAD"} names no commit` };
  const policy = policyAtBase(repo, resolveBase(repo, req.base));
  if (policy.problems.length > 0) return { error: `the policy at base cannot be read: ${policy.problems.join("; ")}` };
  let runner;
  try {
    runner = loadRunnerKey(req.keyPem);
  } catch (err) {
    return { error: `the key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (policy.signers.some((s) => s.key === runner.publicKey)) {
    return { error: `this is a signer's key in ${policy.signersPath}. Runner evidence is signed by a service or CI identity, never by a person's key` };
  }
  const listed = policy.runners.find((r) => r.key === runner.publicKey);
  if (!listed) return { error: `the policy at base lists no runner with this key. Add it to .chant/trust.json "runners" first:\n  ${runner.publicKey}` };

  const loaded = await loadRecordKind(req.kind, req.cwd);
  const read = await readRecords(loaded, { root: repo, source: gitRevisionSource(repo, at) });
  const statement = buildStatement({
    repo,
    commit: at,
    paths: read.records.map((r) => r.path),
    runner: listed.principal,
    check: req.checkId,
    ...(req.claim ? { claim: req.claim } : {}),
    ...(req.environment ? { environment: req.environment } : {}),
  });
  return { envelope: signEvidence(statement, runner.key, runner.publicKey), statement, runner: listed.principal };
}

async function sign(ctx: CommandContext, repo: string): Promise<number> {
  const { args } = ctx;
  if (!args.kind || !args.key || !args.checkId) return fail("--kind, --key and --check-id are required");
  const r = await signRecordsEvidence({
    repo,
    kind: args.kind,
    cwd: process.cwd(),
    keyPem: readFileSync(args.key, "utf-8"),
    checkId: args.checkId,
    at: args.at,
    base: args.base,
    ...(args.claim ? { claim: readFileSync(args.claim) } : {}),
    ...(args.environment ? { environment: readFileSync(args.environment) } : {}),
  });
  if ("error" in r) return fail(r.error);
  const envelope = JSON.stringify(r.envelope, null, 2) + "\n";
  if (args.output) {
    writeFileSync(args.output, envelope);
    console.error(formatSuccess(`signed evidence for ${r.statement.subject.length} records at ${r.statement.predicate.commit.slice(0, 8)} as ${r.runner}: ${args.output}`));
  } else {
    process.stdout.write(envelope);
  }
  return 0;
}

async function verify(ctx: CommandContext, repo: string): Promise<number> {
  const { args } = ctx;
  if (!args.envelope) return fail("--envelope <file> is required");
  const at = commitOf(repo, args.at ?? "HEAD");
  if (!at) return fail(`--at ${args.at ?? "HEAD"} names no commit`);
  const policy = policyAtBase(repo, resolveBase(repo, args.base));
  if (policy.problems.length > 0) return fail(`the policy at base cannot be read: ${policy.problems.join("; ")}`);
  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(args.envelope, "utf-8"));
  } catch (err) {
    return fail(`--envelope ${args.envelope} could not be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const verdict = verifyEvidence(envelope, policy.runners, repo, at);
  if (args.json) {
    console.log(JSON.stringify({ at, ...verdict }, null, 2));
  } else if (!verdict.ok) {
    console.error(formatError({ message: `evidence does not verify: ${verdict.reason}` }));
  } else {
    for (const s of verdict.subjects) console.log(`  ${s.matches ? "same   " : "changed"}  ${s.name}`);
    const p = verdict.statement.predicate;
    const line = `evidence from ${verdict.runner} (${verdict.class}) for check ${p.check} at ${p.commit.slice(0, 8)}: ${verdict.status} at ${at.slice(0, 8)}`;
    if (verdict.status === "current") console.log(formatSuccess(line));
    else console.error(formatError({ message: line, hint: "evidence is not reused for records that changed; run the check again" }));
  }
  return verdict.ok && verdict.status === "current" ? 0 : 1;
}
