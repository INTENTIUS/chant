/**
 * `chant workspace evidence sign|verify` (#2553): runner evidence over the
 * records a kind locates, in a DSSE envelope. See ./evidence.ts.
 *
 * `sign` runs in CI or in a service, with a runner key the policy at base
 * lists. It refuses a key the signers file lists: evidence is a machine's
 * statement, and a developer's key cannot make one. `verify` needs no
 * network and no key, only the envelope and the repository.
 *
 * With `--json`, `verify` prints the `evidence.schema.json` document, and a
 * refused `sign` prints its failure branch.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatError, formatSuccess } from "../../cli/format";
import type { CommandContext } from "../../cli/registry";
import { readerVersion } from "../declaration";
import { gitRevisionSource, gitRoot } from "../record-source";
import { loadRecordKind, readRecords, RecordReadError } from "../records";
import { loadRunnerKey, type DsseEnvelope } from "./dsse";
import { buildStatement, signEvidence, verifyEvidence, EVIDENCE_ERROR_CODES, type EvidenceErrorCode, type EvidenceStatement, type EvidenceVerdict } from "./evidence";
import { policyAtBase, resolveBase } from "./provenance";

export const EVIDENCE_CONTRACT_VERSION = 1;
export const EVIDENCE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/evidence/v1/evidence.schema.json";

const USAGE =
  "chant workspace evidence sign --kind <kind file> --key <runner key.pem> --check-id <id> [--claim <file>] [--environment <file>] [--at <rev>] [--base <rev>] [--output <file>] [--json]\n" +
  "  chant workspace evidence verify --envelope <file> [--at <rev>] [--base <rev>] [--json]";

export interface EvidenceFailure {
  code: EvidenceErrorCode;
  message: string;
}

/** What `evidence verify --json` prints, and a refused `evidence sign --json`. */
export type EvidenceDocument =
  | ({ $schema: string; contract: number; chant: string; at: string } & Extract<EvidenceVerdict, { ok: true }>)
  | { $schema: string; contract: number; chant: string; at: string | null; error: EvidenceFailure };

function head(): { $schema: string; contract: number; chant: string } {
  return { $schema: EVIDENCE_OUTPUT_SCHEMA_ID, contract: EVIDENCE_CONTRACT_VERSION, chant: readerVersion() };
}

function report(json: boolean | undefined, at: string | null, error: EvidenceFailure, usage = false): number {
  if (json) console.log(JSON.stringify({ ...head(), at, error }, null, 2));
  else console.error(formatError({ message: `${error.message} (${error.code})`, ...(usage ? { hint: USAGE } : {}) }));
  return 1;
}

function usage(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return 1;
}

function commitOf(repo: string, rev: string): string | undefined {
  return resolveBase(repo, rev).commit ?? undefined;
}

export async function runWorkspaceEvidence(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const sub = args.extraPositional;
  if (sub !== "sign" && sub !== "verify") return usage(sub ? `Unknown evidence subcommand: ${sub}` : "chant workspace evidence needs sign or verify");
  const repo = gitRoot(process.cwd());
  if (!repo) return report(args.json, null, { code: "not-a-git-repository", message: "runner evidence is bound to git commits, and this directory is not in a git repository" });
  return sub === "sign" ? sign(ctx, repo) : verify(ctx, repo);
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
export async function signRecordsEvidence(
  req: SignRequest,
): Promise<{ envelope: DsseEnvelope; statement: EvidenceStatement; runner: string } | { error: EvidenceFailure }> {
  const { repo } = req;
  const at = commitOf(repo, req.at ?? "HEAD");
  if (!at) return { error: { code: "revision-unknown", message: `--at ${req.at ?? "HEAD"} names no commit` } };
  const policy = policyAtBase(repo, resolveBase(repo, req.base));
  if (policy.problems.length > 0) return { error: { code: "trust-policy-unreadable", message: `the policy at base cannot be read: ${policy.problems.join("; ")}` } };
  let runner;
  try {
    runner = loadRunnerKey(req.keyPem);
  } catch (err) {
    return { error: { code: "runner-key-invalid", message: `the key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}` } };
  }
  if (policy.signers.some((s) => s.key === runner.publicKey)) {
    return {
      error: {
        code: "runner-key-is-signer",
        message: `this is a signer's key in ${policy.signersPath}. Runner evidence is signed by a service or CI identity, never by a person's key`,
      },
    };
  }
  const listed = policy.runners.find((r) => r.key === runner.publicKey);
  if (!listed) {
    return { error: { code: "runner-key-unlisted", message: `the policy at base lists no runner with this key. Add it to .chant/trust.json "runners" first:\n  ${runner.publicKey}` } };
  }

  let paths: string[];
  try {
    const loaded = await loadRecordKind(req.kind, req.cwd);
    const read = await readRecords(loaded, { root: repo, source: gitRevisionSource(repo, at) });
    paths = read.records.map((r) => r.path);
  } catch (err) {
    if (err instanceof RecordReadError && (EVIDENCE_ERROR_CODES as readonly string[]).includes(err.code)) {
      return { error: { code: err.code as EvidenceErrorCode, message: err.message } };
    }
    throw err;
  }
  const statement = buildStatement({
    repo,
    commit: at,
    paths,
    runner: listed.principal,
    check: req.checkId,
    ...(req.claim ? { claim: req.claim } : {}),
    ...(req.environment ? { environment: req.environment } : {}),
  });
  return { envelope: signEvidence(statement, runner.key, runner.publicKey), statement, runner: listed.principal };
}

async function sign(ctx: CommandContext, repo: string): Promise<number> {
  const { args } = ctx;
  if (!args.kind || !args.key || !args.checkId) return usage("--kind, --key and --check-id are required");
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
  if ("error" in r) return report(args.json, null, r.error);
  const envelope = JSON.stringify(r.envelope, null, 2) + "\n";
  if (args.output) {
    writeFileSync(args.output, envelope);
    console.error(formatSuccess(`signed evidence for ${r.statement.subject.length} records at ${r.statement.predicate.commit.slice(0, 8)} as ${r.runner}: ${args.output}`));
  } else {
    process.stdout.write(envelope);
  }
  return 0;
}

/** Verify an envelope file at `at` against the runner keys at base, as the document `--json` prints. */
export function verifyEvidenceFile(repo: string, envelopePath: string, opts: { at?: string; base?: string } = {}): EvidenceDocument {
  const at = commitOf(repo, opts.at ?? "HEAD");
  if (!at) return { ...head(), at: null, error: { code: "revision-unknown", message: `--at ${opts.at ?? "HEAD"} names no commit` } };
  const policy = policyAtBase(repo, resolveBase(repo, opts.base));
  if (policy.problems.length > 0) {
    return { ...head(), at, error: { code: "trust-policy-unreadable", message: `the policy at base cannot be read: ${policy.problems.join("; ")}` } };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, "utf-8"));
  } catch (err) {
    return { ...head(), at, error: { code: "envelope-unreadable", message: `--envelope ${envelopePath} could not be read as JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const verdict = verifyEvidence(envelope, policy.runners, repo, at);
  if (!verdict.ok) return { ...head(), at, error: { code: verdict.code, message: verdict.reason } };
  return { ...head(), at, ...verdict };
}

async function verify(ctx: CommandContext, repo: string): Promise<number> {
  const { args } = ctx;
  if (!args.envelope) return usage("--envelope <file> is required");
  const doc = verifyEvidenceFile(repo, args.envelope, { at: args.at, base: args.base });
  if ("error" in doc) return report(args.json, doc.at, doc.error);
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    for (const s of doc.subjects) console.log(`  ${s.matches ? "same   " : "changed"}  ${s.name}`);
    const p = doc.statement.predicate;
    const line = `evidence from ${doc.runner} (${doc.class}) for check ${p.check} at ${p.commit.slice(0, 8)}: ${doc.status} at ${doc.at.slice(0, 8)}`;
    if (doc.status === "current") console.log(formatSuccess(line));
    else console.error(formatError({ message: line, hint: "evidence is not reused for records that changed; run the check again" }));
  }
  return doc.status === "current" ? 0 : 1;
}
