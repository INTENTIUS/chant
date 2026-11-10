/**
 * `chant ci evidence sign|verify` (#4870): evidence for the named checks a
 * generated pipeline runs, attached to the commit under
 * `refs/notes/chant/evidence`, where #4867's ref gate reads them
 * (../../workspace/trust/check-evidence.ts).
 *
 * - `sign --check-id <id>[,<id>...]` signs that each check passed at `--at`
 *   (default `HEAD`), with the runner key in `--key <file>` or
 *   `CHANT_RUNNER_KEY`, or keyless from the job's OIDC identity with
 *   `CHANT_RUNNER_IDENTITY=oidc` (#4869), and pushes the notes unless
 *   `--no-push`.
 * - `sign --from-report <dir> --result <result>` is the plan note job's
 *   form: it signs `plan` when the plan job succeeded and left a report in
 *   `<dir>`, and `policy` when the policy evaluated inside that plan did not
 *   deny it (a `pr-plan.json`'s `policy`, a plan note hand-off's overrides).
 *   It writes `evidence.json` in `<dir>`, which `pr-post` reads to say in the
 *   note which checks were signed.
 * - `sign --from-report <dir>` on a check job's report (#4935), a
 *   `check-hooks.json` from `chant ci check`, is the `check-evidence` job's
 *   form: it signs each hook that passed, by name, with the runs as its
 *   claim, as `ci check` with a runner identity signs them. A hook skipped on
 *   local evidence did not pass here and is not signed. With `--result`, a
 *   check job that neither succeeded nor failed signs nothing.
 * - `verify --check-id <id>[,<id>...]` reads the evidence for `--at`'s tree
 *   and verifies it against the runner keys at `--base`; exits 1 when one
 *   is not current.
 *
 * Without a runner identity, `sign` signs nothing and says so: a project that
 * declares no runner identity gets the same job it had.
 *
 * `--local` (#4868) is the developer's or agent session's form: `sign
 * --local` signs with the key in `--key` or `CHANT_LOCAL_EVIDENCE_KEY`, which
 * `local.keys` at base lists, and pushes `refs/notes/chant/local-evidence`;
 * `verify --local` says whether CI would skip each check on that evidence.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANT_EXIT } from "../../exit-codes";
import { formatError } from "../format";
import type { CommandContext } from "../registry";
import { gitRoot } from "../../workspace/record-source";
import { resolveBase } from "../../workspace/trust/provenance";
import {
  CHECK_EVIDENCE_KEY_ENV,
  noRunnerIdentity,
  readCheckEvidence,
  recordChecks,
  RUNNER_IDENTITY_ENV,
  runnerEvidenceSigner,
  signChecks,
  type EvidenceSigner,
} from "../../workspace/trust/check-evidence";
import { CHECK_EVIDENCE_FILE, LOCAL_EVIDENCE_KEY_ENV, planReportChecks, type CheckEvidenceNote } from "../../workspace/trust/check-evidence-report";

const USAGE =
  "chant ci evidence sign (--check-id <id>[,<id>...] | --from-report <dir> --result <result>) [--at <rev>] [--base <rev>] [--key <file>] [--claim <file>] [--no-push] [--json]\n" +
  "  chant ci evidence sign --local --check-id <id>[,<id>...] [--at <rev>] [--base <rev>] [--key <file>] [--claim <file>] [--no-push] [--json]\n" +
  "  chant ci evidence verify [--local] --check-id <id>[,<id>...] [--at <rev>] [--base <rev>] [--json]";

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
  if (args.local) return sub === "sign" ? signLocal(ctx, repo, base.commit, at) : verifyLocal(ctx, repo, base.commit, at);
  return sub === "sign" ? sign(ctx, repo, base.commit, at) : verify(ctx, repo, base.commit, at);
}

/** `sign --local` (#4868): local evidence for each named check, signed by a person's or an agent's key. */
async function signLocal(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  const checks = idsOf(args.checkId);
  if (checks.length === 0) return usage("sign --local needs --check-id <id>");
  if (args.fromReport) return usage("--from-report is the plan note job's; plan and policy never take local evidence");
  const pem = args.key ? readFileSync(args.key, "utf-8") : process.env[LOCAL_EVIDENCE_KEY_ENV];
  if (!pem) return usage(`sign --local needs a local evidence key: --key <file> or ${LOCAL_EVIDENCE_KEY_ENV}`);
  const { localKeyEvidenceSigner, recordLocalChecks, signLocalChecks } = await import("../../workspace/trust/local-evidence");
  let signer;
  try {
    signer = localKeyEvidenceSigner(repo, base, pem);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return CHANT_EXIT.failed;
  }
  const claim = args.claim ? readFileSync(args.claim) : undefined;
  const signed = signLocalChecks(repo, at, checks.map((check) => ({ check, ...(claim ? { claim } : {}) })), signer);
  const pushed = await recordLocalChecks(repo, signed, { push: !args.noPush });
  for (const s of signed) console.error(`ci evidence: signed local evidence for ${s.check} at ${s.commit.slice(0, 12)} as ${signer.class} ${s.runner}`);
  if (!args.noPush && !pushed.pushed && pushed.pushWarning) console.error(`ci evidence: the evidence is attached here, and the push did not land: ${pushed.pushWarning}`);
  if (args.json) console.log(JSON.stringify({ signed: signed.map((s) => ({ check: s.check, signer: s.runner, class: signer.class, commit: s.commit, tree: s.tree })) }, null, 2));
  return CHANT_EXIT.done;
}

/** `verify --local` (#4868): whether CI would skip each check on local evidence; exits 1 when one would run. */
async function verifyLocal(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  const checks = idsOf(args.checkId);
  if (checks.length === 0) return usage("verify --local needs --check-id <id>");
  const { acceptedLocalEvidence } = await import("../../workspace/trust/local-evidence");
  const verdicts = acceptedLocalEvidence(repo, at, base, checks);
  if (args.json) console.log(JSON.stringify({ at, base, local: true, checks: verdicts }, null, 2));
  else for (const v of verdicts) console.error(v.status === "accepted" ? `  accepted      ${v.check} (${v.class} ${v.signer} at ${v.commit.slice(0, 12)})` : `  ${v.status.padEnd(12)}  ${v.check}: ${v.reason}`);
  return verdicts.every((v) => v.status === "accepted") ? CHANT_EXIT.done : CHANT_EXIT.failed;
}

async function sign(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  const fromReport = args.fromReport;
  if (!fromReport && idsOf(args.checkId).length === 0) return usage("sign needs --check-id <id>, or --from-report <dir> in a plan note job");
  const pem = args.key ? readFileSync(args.key, "utf-8") : process.env[CHECK_EVIDENCE_KEY_ENV];
  const identity = pem !== undefined && pem !== "" ? "key" : process.env[RUNNER_IDENTITY_ENV] ? "oidc" : undefined;
  const note: CheckEvidenceNote = { signed: [], skipped: [] };
  let wanted: Array<{ check: string; claim?: Buffer | string }>;
  if (fromReport && isCheckReportDir(fromReport)) {
    // #4935: a check job's report, each passed hook signed by name.
    const decided = await checkReportChecks(fromReport, args.planResult);
    if ("error" in decided) return usage(decided.error);
    wanted = decided.sign;
    note.skipped.push(...decided.skipped);
  } else if (fromReport) {
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
  if (!identity) {
    note.skipped.push(...wanted.map((w) => ({ check: w.check, reason: noRunnerIdentity() })));
    console.error(`ci evidence: ${noRunnerIdentity()}, so no check was signed`);
    return finish(CHANT_EXIT.done);
  }
  let signer: EvidenceSigner;
  try {
    signer = (await runnerEvidenceSigner(repo, base, pem ? { key: pem } : {}))!;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return finish(CHANT_EXIT.failed);
  }
  for (const s of note.skipped) console.error(`ci evidence: ${s.check} not signed: ${s.reason}`);
  if (wanted.length === 0) return finish(CHANT_EXIT.done);
  const signed = await signChecks(repo, at, wanted, signer);
  const pushed = await recordChecks(repo, signed, { push: !args.noPush });
  for (const s of signed) {
    note.signed.push({ check: s.check, runner: s.runner, commit: s.commit, tree: s.tree });
    console.error(`ci evidence: signed ${s.check} at ${s.commit.slice(0, 12)} as ${s.runner}`);
  }
  if (!args.noPush && !pushed.pushed && pushed.pushWarning) console.error(`ci evidence: the evidence is attached here, and the push did not land: ${pushed.pushWarning}`);
  return finish(CHANT_EXIT.done);
}

/** Whether `dir` holds a check job's report and no plan report (#4935). */
function isCheckReportDir(dir: string): boolean {
  return existsSync(join(dir, "check-hooks.json")) && !existsSync(join(dir, "pr-plan.json")) && !existsSync(join(dir, "pr-plan-note.json"));
}

/**
 * The hooks to sign from a check job's report (#4935): each hook whose every
 * run passed, with its runs as the claim, as the check runner signs them
 * (../../components/check-steps.ts). The report is the check job's, which ran
 * the change's code, so it is read as data: a hook with no name or outcome is
 * left out. A job `result` other than success or failure signs none.
 */
async function checkReportChecks(dir: string, result: string | undefined): Promise<{ sign: Array<{ check: string; claim: string }>; skipped: CheckEvidenceNote["skipped"] } | { error: string }> {
  const { CHECK_HOOKS_REPORT_FILE, passedCheckHooks } = await import("../../components/check-hooks");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(dir, CHECK_HOOKS_REPORT_FILE), "utf-8"));
  } catch (err) {
    return { error: `--from-report ${dir}: ${CHECK_HOOKS_REPORT_FILE} does not read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const hooks = doc && typeof doc === "object" && Array.isArray((doc as { hooks?: unknown }).hooks) ? ((doc as { hooks: unknown[] }).hooks as Array<Record<string, unknown>>) : undefined;
  if (!hooks) return { error: `--from-report ${dir}: ${CHECK_HOOKS_REPORT_FILE} lists no hooks` };
  const runs = hooks.filter((h) => h && typeof h.name === "string" && h.name.length > 0 && h.name.length <= 200 && (h.outcome === "passed" || h.outcome === "failed" || h.outcome === "skipped"));
  const passed = passedCheckHooks(runs as unknown as Parameters<typeof passedCheckHooks>[0]);
  if (result !== undefined && result !== "success" && result !== "failure") {
    return { sign: [], skipped: passed.map((p) => ({ check: p.check, reason: `the check job's result is ${result}` })) };
  }
  const signed = new Set(passed.map((p) => p.check));
  const skipped = [...new Set(runs.map((h) => h.name as string))].filter((n) => !signed.has(n)).map((check) => ({ check, reason: "the hook did not pass in the check job" }));
  return { sign: passed.map((p) => ({ check: p.check, claim: JSON.stringify(p.runs) })), skipped };
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

