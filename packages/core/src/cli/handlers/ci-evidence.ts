/**
 * `chant ci evidence sign|verify` (#4870): evidence for the named checks a
 * generated pipeline runs, attached to the commit under
 * `refs/notes/chant/evidence`, where #4867's ref gate reads them
 * (../../workspace/trust/check-evidence.ts).
 *
 * - `sign --check-id <id>[,<id>...]` signs that each check passed at `--at`
 *   (default `HEAD`), with the runner key in `--key <file>` or
 *   `CHANT_RUNNER_KEY`, and pushes the notes unless `--no-push`.
 * - `sign --from-report <dir> --result <result>` is the plan note job's
 *   form: it signs `plan` when the plan job succeeded and left a report in
 *   `<dir>`, and `policy` when the policy evaluated inside that plan did not
 *   deny it (a `pr-plan.json`'s `policy`, a plan note hand-off's overrides).
 *   It writes `evidence.json` in `<dir>`, which `pr-post` reads to say in the
 *   note which checks were signed.
 * - `verify --check-id <id>[,<id>...]` reads the evidence for `--at`'s tree
 *   and verifies it against the runner keys at `--base`; exits 1 when one
 *   is not current.
 *
 * Without a runner key, `sign` signs nothing and says so: a project that
 * declares no runner identity gets the same job it had.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANT_EXIT } from "../../exit-codes";
import { formatError } from "../format";
import type { CommandContext } from "../registry";
import { gitRoot } from "../../workspace/record-source";
import { resolveBase } from "../../workspace/trust/provenance";
import {
  CHECK_EVIDENCE_KEY_ENV,
  readCheckEvidence,
  recordChecks,
  runnerKeyEvidenceSigner,
  signChecks,
  type EvidenceSigner,
} from "../../workspace/trust/check-evidence";
import { CHECK_EVIDENCE_FILE, planReportChecks, type CheckEvidenceNote } from "../../workspace/trust/check-evidence-report";

const USAGE =
  "chant ci evidence sign (--check-id <id>[,<id>...] | --from-report <dir> --result <result>) [--at <rev>] [--base <rev>] [--key <file>] [--claim <file>] [--no-push] [--json]\n" +
  "  chant ci evidence verify --check-id <id>[,<id>...] [--at <rev>] [--base <rev>] [--json]";

function usage(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return CHANT_EXIT.failed;
}

function idsOf(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export async function runCiEvidence(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const sub = args.extraPositional;
  if (sub !== "sign" && sub !== "verify") return usage(sub ? `Unknown evidence subcommand: ${sub}` : "chant ci evidence needs sign or verify");
  const repo = gitRoot(process.cwd());
  if (!repo) return usage("check evidence is bound to git commits, and this directory is not in a git repository");
  const base = resolveBase(repo, args.base);
  if (!base.commit) return usage(base.problem ?? "no base: pass --base <rev>, the commit whose .chant/trust.json lists the runner keys");
  const at = args.at ?? "HEAD";
  return sub === "sign" ? sign(ctx, repo, base.commit, at) : verify(ctx, repo, base.commit, at);
}

async function sign(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  const fromReport = args.fromReport;
  if (!fromReport && idsOf(args.checkId).length === 0) return usage("sign needs --check-id <id>, or --from-report <dir> in a plan note job");
  const pem = args.key ? readFileSync(args.key, "utf-8") : process.env[CHECK_EVIDENCE_KEY_ENV];
  const note: CheckEvidenceNote = { signed: [], skipped: [] };
  let wanted: Array<{ check: string; claim?: Buffer | string }>;
  if (fromReport) {
    const decided = planReportChecks(fromReport, args.planResult);
    wanted = decided.sign;
    note.skipped.push(...decided.skipped);
  } else {
    const claim = args.claim ? readFileSync(args.claim) : undefined;
    wanted = idsOf(args.checkId).map((check) => ({ check, ...(claim ? { claim } : {}) }));
  }
  const finish = (code: number): number => {
    if (fromReport) writeFileSync(join(fromReport, CHECK_EVIDENCE_FILE), JSON.stringify(note, null, 2) + "\n");
    if (args.json) console.log(JSON.stringify(note, null, 2));
    return code;
  };
  if (!pem) {
    note.skipped.push(...wanted.map((w) => ({ check: w.check, reason: `no runner key: ${CHECK_EVIDENCE_KEY_ENV} is not set` })));
    console.error(`ci evidence: no runner key in ${CHECK_EVIDENCE_KEY_ENV}, so no check was signed`);
    return finish(CHANT_EXIT.done);
  }
  let signer: EvidenceSigner;
  try {
    signer = runnerKeyEvidenceSigner(repo, base, pem);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return finish(CHANT_EXIT.failed);
  }
  for (const s of note.skipped) console.error(`ci evidence: ${s.check} not signed: ${s.reason}`);
  if (wanted.length === 0) return finish(CHANT_EXIT.done);
  const signed = signChecks(repo, at, wanted, signer);
  const pushed = await recordChecks(repo, signed, { push: !args.noPush });
  for (const s of signed) {
    note.signed.push({ check: s.check, runner: s.runner, commit: s.commit, tree: s.tree });
    console.error(`ci evidence: signed ${s.check} at ${s.commit.slice(0, 12)} as ${s.runner}`);
  }
  if (!args.noPush && !pushed.pushed && pushed.pushWarning) console.error(`ci evidence: the evidence is attached here, and the push did not land: ${pushed.pushWarning}`);
  return finish(CHANT_EXIT.done);
}

async function verify(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  const checks = idsOf(args.checkId);
  if (checks.length === 0) return usage("verify needs --check-id <id>");
  const verdicts = await readCheckEvidence(repo, at, base, checks);
  if (args.json) console.log(JSON.stringify({ at, base, checks: verdicts }, null, 2));
  else for (const v of verdicts) console.error(v.status === "current" ? `  current  ${v.check} (signed by ${v.runner} at ${v.commit.slice(0, 12)})` : `  ${v.status.padEnd(7)}  ${v.check}: ${v.reason}`);
  return verdicts.every((v) => v.status === "current") ? CHANT_EXIT.done : CHANT_EXIT.failed;
}

