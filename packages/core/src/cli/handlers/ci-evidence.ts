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
 *   note which checks were signed. With `--member <name>` (#4964), a
 *   workspace member's plan report, the two are `plan:<name>` and
 *   `policy:<name>`.
 * - `sign --from-report <dir>` on a check job's report (#4935), a
 *   `check-hooks.json` from `chant ci check`, is the `check-evidence` job's
 *   form: it signs each hook that passed, by name, with the runs as its
 *   claim, as `ci check` with a runner identity signs them. A hook skipped on
 *   local evidence did not pass here and is not signed. With `--result`, a
 *   check job that neither succeeded nor failed signs nothing.
 * - `sign --open --job <job> --from-report <dir> -o <out>` (#4914) is the
 *   GitLab signing job's form, in a pipeline of the target branch: for each
 *   open merge request it reads the report from the newest pipeline's
 *   `<job>` artifact, fetches the head and signs it as `--from-report`
 *   does, skipping a check already signed for the head's tree, and keeps
 *   `<out>/<iid>/evidence.json` for the note job. No job of a merge request
 *   pipeline, which the change's own files build, holds the key.
 * - `sign --from-job <job> --check-id <id>[,<id>...] [--claims <dir>]`
 *   (#4926) is a wave's evidence job's form: it reads the job of that name
 *   in this run through the forge, refuses one of another run or commit,
 *   and signs each check whose step (named in `CHANT_EVIDENCE_SOURCES`; on
 *   GitLab, whose jobs have no steps, the job) the forge reports passed and
 *   whose claim file in `<dir>` says so. Each statement names the run, job
 *   and step it relied on (`source`).
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
import { execFileSync, spawnSync } from "node:child_process";
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
  "chant ci evidence sign (--check-id <id>[,<id>...] | --from-report <dir> [--member <name>] --result <result>) [--at <rev>] [--base <rev>] [--key <file>] [--claim <file>] [--no-push] [--json]\n" +
  "  chant ci evidence sign --open --job <job> --from-report <dir> [--member <name>] -o <out> [--branch <branch>] [--base <rev>] [--key <file>] [--no-push] [--json]\n" +
  "  chant ci evidence sign --from-job <job> --check-id <id>[,<id>...] [--claims <dir>] [--at <rev>] [--base <rev>] [--key <file>] [--no-push] [--json]\n" +
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

/**
 * `sign --from-job <job>` (#4926): the wave's evidence job, signing each
 * named check whose step in that job of this run and commit the forge
 * reports as passed (../../ci-evidence-from-job.ts). Exits 1 when the job is
 * another run's or commit's.
 */
async function signFromJobCommand(ctx: CommandContext, repo: string, base: string): Promise<number> {
  const { args } = ctx;
  const checks = idsOf(args.checkId);
  if (checks.length === 0) return usage("sign --from-job needs --check-id <id>[,<id>...], the checks the job ran");
  if (args.fromReport) return usage("--from-job and --from-report are two ways to sign; pass one");
  const pem = args.key ? readFileSync(args.key, "utf-8") : undefined;
  try {
    const { forgeTargetFromEnv } = await import("../../pr-forge");
    const { forgeReadsFor } = await import("../../pr-forge-reads");
    const { signFromJob } = await import("../../ci-evidence-from-job");
    const reads = forgeReadsFor(forgeTargetFromEnv(process.env));
    const done = await signFromJob({ repo, base, fromJob: args.fromJob!, checks, ...(args.claims ? { claims: args.claims } : {}), ...(args.at ? { at: args.at } : {}), reads, ...(pem ? { key: pem } : {}), push: !args.noPush });
    if ("refused" in done) {
      console.error(formatError({ message: `ci evidence: ${done.refused}`, hint: USAGE }));
      return CHANT_EXIT.failed;
    }
    if (args.json) console.log(JSON.stringify({ signed: done.signed, skipped: done.skipped }, null, 2));
    return CHANT_EXIT.done;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return CHANT_EXIT.failed;
  }
}

async function sign(ctx: CommandContext, repo: string, base: string, at: string): Promise<number> {
  const { args } = ctx;
  if (args.open && args.fromJob) return usage("--open and --from-job are two ways to sign; pass one");
  if (args.open) return signOpen(ctx, repo, base);
  if (args.fromJob) return signFromJobCommand(ctx, repo, base);
  const fromReport = args.fromReport;
  if (!fromReport && idsOf(args.checkId).length === 0) return usage("sign needs --check-id <id>, or --from-report <dir> in a plan note job");
  const member = memberOf(args.members, Boolean(fromReport));
  if (typeof member === "object") return usage(member.usage);
  const pem = args.key ? readFileSync(args.key, "utf-8") : process.env[CHECK_EVIDENCE_KEY_ENV];
  let wanted: Array<{ check: string; claim?: Buffer | string }> | undefined;
  if (!fromReport) {
    const claim = args.claim ? readFileSync(args.claim) : undefined;
    wanted = idsOf(args.checkId).map((check) => ({ check, ...(claim ? { claim } : {}) }));
  }
  const done = await signChecksOf(repo, base, at, { ...(fromReport ? { fromReport } : {}), ...(wanted ? { wanted } : {}), ...(args.planResult ? { result: args.planResult } : {}), ...(member ? { member } : {}), pem, push: !args.noPush });
  if ("usage" in done) return usage(done.usage);
  if (fromReport) writeFileSync(join(fromReport, CHECK_EVIDENCE_FILE), JSON.stringify(done.note, null, 2) + "\n");
  if (args.json) console.log(JSON.stringify(done.note, null, 2));
  return done.code;
}

/**
 * `--member <name>` (#4964): the workspace member whose plan report this is,
 * so `plan` and `policy` are signed as `plan:<name>` and `policy:<name>`.
 * One name, and only with a plan report.
 */
function memberOf(members: string[] | undefined, fromReport: boolean): string | undefined | { usage: string } {
  if (!members || members.length === 0) return undefined;
  if (!fromReport) return { usage: "--member names the member whose plan report --from-report signs; --check-id names its checks in full" };
  if (members.length > 1 || !/^[a-z0-9][a-z0-9-]*$/.test(members[0]!)) return { usage: `--member takes one member name, lower-case letters, digits and -, not ${members.join(",")}` };
  return members[0];
}

/**
 * Sign the checks of a report directory (`fromReport`) or the named ones
 * (`wanted`) at `at`, against the runner identities at `base`. With
 * `skipCurrent` (#4914), a check whose current evidence the notes already
 * hold is not signed again and is listed as signed by that runner, so a
 * pipeline that runs on every schedule signs each head once.
 */
async function signChecksOf(
  repo: string,
  base: string,
  at: string,
  opts: { fromReport?: string; wanted?: Array<{ check: string; claim?: Buffer | string }>; result?: string; member?: string; pem?: string; push: boolean; skipCurrent?: boolean },
): Promise<{ note: CheckEvidenceNote; code: number } | { usage: string }> {
  const { fromReport, pem } = opts;
  const identity = pem !== undefined && pem !== "" ? "key" : process.env[RUNNER_IDENTITY_ENV] ? "oidc" : undefined;
  const note: CheckEvidenceNote = { signed: [], skipped: [] };
  let wanted: Array<{ check: string; claim?: Buffer | string }>;
  if (fromReport && isCheckReportDir(fromReport)) {
    // #4935: a check job's report, each passed hook signed by name; #4964: a hook is the workspace's or the member's by its own name.
    if (opts.member) return { usage: `--member names a plan report's member, and ${fromReport} is a check job's report, whose hooks are signed by their own names` };
    const decided = await checkReportChecks(fromReport, opts.result);
    if ("error" in decided) return { usage: decided.error };
    wanted = decided.sign;
    note.skipped.push(...decided.skipped);
  } else if (fromReport) {
    const decided = planReportChecks(fromReport, opts.result, opts.member);
    wanted = decided.sign;
    note.skipped.push(...decided.skipped);
  } else {
    wanted = opts.wanted ?? [];
  }
  if (!identity) {
    note.skipped.push(...wanted.map((w) => ({ check: w.check, reason: noRunnerIdentity() })));
    console.error(`ci evidence: ${noRunnerIdentity()}, so no check was signed`);
    return { note, code: CHANT_EXIT.done };
  }
  let signer: EvidenceSigner;
  try {
    signer = (await runnerEvidenceSigner(repo, base, pem ? { key: pem } : {}))!;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return { note, code: CHANT_EXIT.failed };
  }
  for (const s of note.skipped) console.error(`ci evidence: ${s.check} not signed: ${s.reason}`);
  if (opts.skipCurrent && wanted.length > 0) {
    const { tree } = commitTree(repo, at);
    const current = (await readCheckEvidence(repo, at, base, wanted.map((w) => w.check))).filter((v) => v.status === "current");
    for (const v of current) {
      note.signed.push({ check: v.check, runner: v.runner, commit: v.commit, tree });
      console.error(`ci evidence: ${v.check} at ${at.slice(0, 12)} is already signed by ${v.runner}`);
    }
    const kept = new Set(current.map((v) => v.check));
    wanted = wanted.filter((w) => !kept.has(w.check));
  }
  if (wanted.length === 0) return { note, code: CHANT_EXIT.done };
  const signed = await signChecks(repo, at, wanted, signer);
  const pushed = await recordChecks(repo, signed, { push: opts.push });
  for (const s of signed) {
    note.signed.push({ check: s.check, runner: s.runner, commit: s.commit, tree: s.tree });
    console.error(`ci evidence: signed ${s.check} at ${s.commit.slice(0, 12)} as ${s.runner}`);
  }
  if (opts.push && !pushed.pushed && pushed.pushWarning) console.error(`ci evidence: the evidence is attached here, and the push did not land: ${pushed.pushWarning}`);
  return { note, code: CHANT_EXIT.done };
}

/** A commit's full sha and tree, read with git. */
function commitTree(repo: string, rev: string): { commit: string; tree: string } {
  const read = (spec: string) => execFileSync("git", ["rev-parse", "--verify", spec], { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { commit: read(`${rev}^{commit}`), tree: read(`${rev}^{tree}`) };
}

/**
 * `sign --open --job <job> --from-report <dir> -o <out>` (#4914): in a
 * GitLab pipeline of the target branch, sign each open merge request's
 * settled `job` from its artifact (../../workspace/trust/open-evidence.ts),
 * against the policy at `--base` (the generated job passes the branch's
 * commit). The branch is `--branch`, else the pipeline's own. Exits 0 once
 * each merge request is signed or said, and 1 when the job's runner
 * identity is not one the policy at base lists.
 */
async function signOpen(ctx: CommandContext, repo: string, base: string): Promise<number> {
  const { args } = ctx;
  if (!args.ciJob || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(args.ciJob)) return usage("sign --open needs the job to sign for, by name: --job plan");
  if (!args.fromReport) return usage("sign --open needs the job's report directory as its artifact keeps it: --from-report .chant/pr");
  if (!args.output) return usage("sign --open needs where to keep each merge request's evidence.json: -o .chant/evidence/<job>");
  if (args.checkId || args.at || args.planResult) return usage("sign --open finds each merge request's head and its job's result itself, so it takes no --check-id, --at or --result");
  const member = memberOf(args.members, true);
  if (typeof member === "object") return usage(member.usage);
  const branch = args.branch ?? process.env.CI_COMMIT_BRANCH;
  if (!branch) return usage("sign --open signs for the merge requests into a branch: run it in a branch pipeline, or pass --branch <branch>");
  const pem = args.key ? readFileSync(args.key, "utf-8") : process.env[CHECK_EVIDENCE_KEY_ENV];
  const { forgeFromEnv } = await import("../../pr-forge");
  const { signOpenReports } = await import("../../workspace/trust/open-evidence");
  // The notes there are the ones to skip a head already signed by, and to add to.
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", "+refs/notes/chant/evidence:refs/notes/chant/evidence"], { cwd: repo, encoding: "utf-8" });
  let failed = false;
  let done: Awaited<ReturnType<typeof signOpenReports>>;
  try {
    done = await signOpenReports({
      forge: forgeFromEnv("gitlab"),
      branch,
      job: args.ciJob,
      artifactDir: args.fromReport,
      out: args.output,
      ...(args.noForks ? { noForks: true } : {}),
      fetchHead: (pr, head) => fetchMergeRequestHead(repo, pr, head),
      sign: async (dir, head, result) => {
        const r = await signChecksOf(repo, base, head, { fromReport: dir, result, ...(member ? { member } : {}), ...(pem ? { pem } : {}), push: !args.noPush, skipCurrent: true });
        if ("usage" in r) throw new Error(r.usage);
        if (r.code !== CHANT_EXIT.done) failed = true;
        return r.note;
      },
    });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return CHANT_EXIT.failed;
  }
  for (const w of done.warnings) console.error(`ci evidence: ${w}`);
  for (const d of done.done) {
    if (d.skipped) console.error(`ci evidence: !${d.pr}: ${d.skipped}`);
    else console.error(`ci evidence: !${d.pr} at ${d.head.slice(0, 12)}: signed ${d.note!.signed.map((s) => s.check).join(", ") || "nothing"}`);
  }
  if (done.done.length === 0) console.error(`ci evidence: no open merge request into ${branch} has a ${args.ciJob} job`);
  if (args.json) console.log(JSON.stringify(done.done, null, 2));
  return failed ? CHANT_EXIT.failed : CHANT_EXIT.done;
}

/** Fetch merge request `pr`'s head (`refs/merge-requests/<iid>/head`, a fork's too), else the commit itself; true once it is here. */
function fetchMergeRequestHead(repo: string, pr: number, head: string): boolean {
  const here = () => spawnSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: repo }).status === 0;
  if (here()) return true;
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", `refs/merge-requests/${pr}/head`], { cwd: repo, encoding: "utf-8" });
  if (here()) return true;
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", head], { cwd: repo, encoding: "utf-8" });
  return here();
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

