/**
 * `chant approve <op> <gate> --resume` and `chant run resume` (#3683): start
 * the CI job that waits at a gate again once its approval has arrived. See
 * `../../op/gate-resume.ts` for what each forge is asked and the token it
 * needs. Neither approves anything.
 *
 * A gate that asks a decision point (#3170) waits on a question, not on an
 * approval: its pending fact cites the question, and the gate's resolution is
 * only written when the run asks again. So such a fact is resumable once the
 * question has an answer that passes the gate (`pointGateResumable`, #3835),
 * and `chant workspace points answer --resume` resumes the job right after
 * the answer.
 *
 * What to resume is decided from the ledger by `planGateResumes`
 * (`../../op/gate-resume-plan.ts`, #3858): an approval a wave already applied
 * under is spent and resumes nothing, and an apply under an approval that
 * stopped (an applied line with a run locator and no finished line) resumes
 * once the forge says its run is gone.
 */

import {
  GATES_DIR,
  readGateLedger,
  type GateResolutionRecord,
  type PendingGateRecord,
} from "../../lifecycle/gate-ledger";
import { appliedGatePath, parseAppliedGateFile, type AppliedGateLine, type FinishedGateRecord } from "../../lifecycle/gate-applied";
import { listFilesInDir, pushLifecycleStatus, readBlobFromPath, requireLifecycleLedger } from "../../lifecycle/git";
import { parseGateSubject } from "../../op/gate-point";
import { quorumRules, ruleNeedsProof, trustQuorumJudge, type GateQuorumJudge } from "../../op/gate-quorum";
import {
  resolutionAnswering,
  resumeGateRun,
  resumeTokenFromEnv,
  type GateResumeOutcome,
} from "../../op/gate-resume";
import { planGateResumes, type GateResumeCandidate, type GateResumeReason } from "../../op/gate-resume-plan";
import type { GateRunLocator } from "../../op/gate-run-locator";
import type { PointQuestionState } from "../../point-decision";
import type { ForgeFetch } from "../../pr-forge";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * One gate a resume looked at and what it did. With `--json`, `chant run
 * resume` prints these as `{ reports }`; under `--dry-run` it starts nothing,
 * so a product that resumes in its own job reads `resumable` and `reason`
 * (#3858).
 */
export interface GateResumeReport {
  op: string;
  gate: string;
  environment?: string;
  /** A standing pending fact, or an apply under an approval that stopped (#3858). */
  source: GateResumeCandidate["source"];
  /**
   * What happened. `resumed`, `skipped` and `would-resume` (`--dry-run`) come
   * from the forge; the rest are decided before any call.
   */
  status: GateResumeOutcome["status"] | "not-approved" | "spent" | "no-job" | "no-token" | "failed";
  /** Why, from the ledger: `approved`, `answered`, `not-approved`, `spent` or `stopped`. */
  reason: GateResumeReason;
  /**
   * Whether the gate's job should start again: an approval or a passing
   * answer stands and is not spent, or an apply stopped and the run that
   * applied is gone. A product that applies in its own job acts on these.
   */
  resumable: boolean;
  message: string;
  planDigest?: string;
  approvedBy?: string;
  approvedAt?: string;
  url?: string;
  /** The job a resume starts again. */
  run?: GateRunLocator;
  spent?: GateResumeCandidate["spent"];
  /** `runGone` is what the forge said about the run that applied; absent when it was not asked. */
  stopped?: GateResumeCandidate["stopped"] & { runGone?: boolean };
}

export interface ResumeGateOptions {
  env?: Record<string, string | undefined>;
  fetch?: ForgeFetch;
  now?: string;
  dryRun?: boolean;
  /**
   * The workspace's questions by id, for a fact a gate that asks a decision
   * point recorded (#3835). Read from the workspace at the working directory
   * when a fact needs them and none are given.
   */
  questions?: ReadonlyMap<string, PointQuestionState>;
  /** The lines of `_gates/<op>/applied.jsonl` (#3858). Read from `chant/lifecycle` by {@link resumeOpGates} when not given. */
  applied?: readonly AppliedGateLine[];
  finished?: readonly FinishedGateRecord[];
  /** Proves approvers for approval rules that name roles (#4290). Read from the trust policy at base when a fact needs one and none is given. */
  judge?: GateQuorumJudge;
}

/** The judge a fact's approval rules are met by (#4290): the trust policy at base, read only when a rule names roles or notAuthor. */
async function judgeFor(pending: readonly PendingGateRecord[], opts: ResumeGateOptions): Promise<GateQuorumJudge | undefined> {
  if (opts.judge) return opts.judge;
  if (!pending.some((p) => quorumRules(p.approval?.quorum).some(ruleNeedsProof))) return undefined;
  const { scopeSource } = await import("../../workspace/write-scope");
  const { policy } = scopeSource(process.cwd());
  return trustQuorumJudge({ signers: policy, roles: policy.roles });
}

/** Every question the workspace at `cwd` lists, by id, the lifecycle ledger's included. Empty when the workspace can't be read. */
export async function workspaceQuestions(cwd: string): Promise<Map<string, PointQuestionState>> {
  const { workspacePoints } = await import("../../workspace/points-cli");
  const doc = await workspacePoints({ cwd }).catch(() => undefined);
  if (!doc || !("questions" in doc)) return new Map();
  return new Map(doc.questions.map((q) => [q.id, { id: q.id, state: q.state, answer: q.answer, answeredBy: q.answeredBy, answeredOn: q.answeredOn }]));
}

/** Resume the job behind one standing pending fact, when an approval answers it and is not spent. */
export async function resumeStanding(
  standing: PendingGateRecord,
  resolutions: readonly GateResolutionRecord[],
  opts: ResumeGateOptions = {},
  pending: readonly PendingGateRecord[] = [standing],
): Promise<GateResumeReport> {
  const judge = await judgeFor([standing], opts);
  const [candidate] = planGateResumes({
    op: standing.op,
    pending: [standing],
    resolutions,
    applied: opts.applied ?? [],
    now: standing.timestamp,
    ...(opts.questions ? { questions: opts.questions } : {}),
    answering: (r, s) => resolutionAnswering(r, s, pending, judge),
  });
  return resumeCandidate(candidate!, opts);
}

/**
 * Act on one candidate {@link planGateResumes} decided: start its job again
 * through the forge, or under `dryRun` ask the forge whether it would. A
 * stopped apply is resumed only once the forge says its run is gone.
 */
export async function resumeCandidate(c: GateResumeCandidate, opts: ResumeGateOptions = {}): Promise<GateResumeReport> {
  const base: GateResumeReport = {
    op: c.op,
    gate: c.gate,
    ...(c.environment !== undefined ? { environment: c.environment } : {}),
    source: c.source,
    status: "not-approved",
    reason: c.reason,
    resumable: c.resumable,
    message: c.message,
    ...(c.planDigest !== undefined ? { planDigest: c.planDigest } : {}),
    ...(c.approvedBy !== undefined ? { approvedBy: c.approvedBy } : {}),
    ...(c.approvedAt !== undefined ? { approvedAt: c.approvedAt } : {}),
    ...(c.run?.url ? { url: c.run.url } : {}),
    ...(c.run ? { run: c.run } : {}),
    ...(c.spent ? { spent: c.spent } : {}),
    ...(c.stopped ? { stopped: { ...c.stopped } } : {}),
  };
  if (c.reason === "spent") return { ...base, status: "spent" };
  if (!c.resumable) return base;
  if (!c.run) {
    return { ...base, status: "no-job", message: "its pending fact names no CI job (it was recorded outside CI); run it again by hand" };
  }
  const stopped = c.source === "stopped";
  const token = resumeTokenFromEnv(c.run.forge, opts.env ?? process.env);
  // A waiting job needs no forge call to say it would resume; a stopped apply needs one to know its run is gone.
  if (opts.dryRun && !stopped) return { ...base, status: "would-resume", message: `would resume ${c.run.forge} run ${c.run.run}; ${c.message}` };
  if (!token) {
    const need = `${c.run.forge === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN"}`;
    return {
      ...base,
      ...(stopped ? { resumable: false } : {}),
      status: "no-token",
      message: stopped
        ? `${c.message}; whether run ${c.run.run} is gone needs a token to read ${c.run.forge} with: set CHANT_FORGE_TOKEN (or ${need})`
        : `no token to call ${c.run.forge} with: set CHANT_FORGE_TOKEN (or ${need})`,
    };
  }
  try {
    const since = stopped ? c.stopped!.appliedAt : c.approvedAt;
    const outcome = await resumeGateRun(c.run, { token, ...(since ? { since } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.dryRun ? { dryRun: true } : {}) });
    const message = outcome.status === "skipped" ? outcome.reason : outcome.how;
    if (!stopped) return { ...base, status: outcome.status, message };
    const gone = outcome.status !== "skipped";
    return {
      ...base,
      status: outcome.status,
      resumable: gone,
      message: gone ? `the apply that began at ${c.stopped!.appliedAt} stopped and its run is gone: ${message}` : `the apply that began at ${c.stopped!.appliedAt} is left alone: ${message}`,
      stopped: { ...c.stopped!, runGone: gone },
    };
  } catch (err) {
    return { ...base, status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The `applied` and `finished` lines of `_gates/<op>/applied.jsonl` on `chant/lifecycle`. */
export async function readAppliedGateFile(op: string): Promise<{ applied: AppliedGateLine[]; finished: FinishedGateRecord[] }> {
  const { dir, file } = appliedGatePath(op);
  const text = await readBlobFromPath(dir, file);
  return text ? parseAppliedGateFile(text) : { applied: [], finished: [] };
}

/**
 * Resume every job waiting on `op`'s gates (or one gate) whose approval
 * arrived and is not spent, and every apply under an approval that stopped
 * once its run is gone (#3858).
 */
export async function resumeOpGates(op: string, gate: string | undefined, opts: ResumeGateOptions = {}): Promise<GateResumeReport[]> {
  const ledger = await readGateLedger(op);
  const lines = opts.applied ? { applied: opts.applied, finished: opts.finished ?? [] } : await readAppliedGateFile(op);
  const now = opts.now ?? new Date().toISOString();
  // Read the workspace's questions once, and only when a fact waits on one (#3835).
  const questions = opts.questions ?? (ledger.pending.some((p) => p.answer) ? await workspaceQuestions(process.cwd()) : undefined);
  const judge = await judgeFor(ledger.pending, opts);
  const candidates = planGateResumes({
    op,
    pending: ledger.pending,
    resolutions: ledger.resolutions,
    applied: lines.applied,
    finished: lines.finished,
    now,
    ...(gate !== undefined ? { gate } : {}),
    ...(questions ? { questions } : {}),
    answering: (r, s, p) => resolutionAnswering(r, s, p, judge),
  });
  const reports: GateResumeReport[] = [];
  for (const c of candidates) reports.push(await resumeCandidate(c, opts));
  return reports;
}

function printReport(r: GateResumeReport): void {
  const where = `${r.op} / ${r.gate}${r.environment !== undefined ? ` (${r.environment})` : ""}`;
  const by = r.approvedBy ? `, approved by ${r.approvedBy}` : "";
  const link = r.url ? ` ${r.url}` : "";
  if (r.status === "resumed") console.error(formatSuccess(`${where}${by}: ${r.message}${link}`));
  else if (r.status === "would-resume") console.error(formatInfo(`${where}${by}: ${r.message}${link}`));
  else if (r.status === "failed" || r.status === "no-token") {
    console.error(formatError({
      message: `${where}${by}: not resumed: ${r.message}`,
      hint: "GitHub needs actions: write; GitLab a token with the api scope and the Developer role; Forgejo a token with write:repository.",
    }));
  } else console.error(formatInfo(`${where}${by}: not resumed: ${r.message}${link}`));
}

/**
 * What `chant approve --resume` runs once the approval is recorded and
 * pushed. Returns the exit code: 0 when the job was resumed or had nothing to
 * resume, 1 when a forge call failed or no token was found.
 */
export async function resumeAfterApproval(op: string, gate: string, environment: string | undefined, pushed: boolean): Promise<number> {
  if (!pushed) {
    console.error(formatWarning({
      message: "Not resuming: the approval did not reach the remote, so the resumed job would not see it.",
      hint: "Push chant/lifecycle, then run `chant run resume --op " + op + "`.",
    }));
    return 1;
  }
  const reports = (await resumeOpGates(op, gate)).filter((r) => environment === undefined || r.environment === environment);
  if (reports.length === 0) {
    console.error(formatInfo(`No pending fact for ${op} / ${gate} is waiting, so there is nothing to resume.`));
    return 0;
  }
  for (const r of reports) printReport(r);
  return reports.some((r) => r.status === "failed" || r.status === "no-token") ? 1 : 0;
}

/**
 * What `chant workspace points answer --resume` runs once the answer is
 * written (#3835): resume the job waiting at the gate the question names in
 * its subject (`gate:<op>/<gate>`), when the answer passes it. The answer has
 * to be on the remote for the resumed job to see it: one held on
 * `chant/lifecycle` is pushed again here, and one in the working tree is
 * not resumed on, since the job reads it only once it is committed and pushed.
 * Returns the exit code, as {@link resumeAfterApproval} does.
 */
export async function resumeAfterAnswer(question: { id: string; subject: string | null; ledger: string | null }, cwd: string = process.cwd()): Promise<number> {
  const named = parseGateSubject(question.subject);
  if (!named) {
    console.error(formatInfo(`Question ${question.id} names no gate in its subject, so there is nothing to resume.`));
    return 0;
  }
  if (question.ledger === null) {
    console.error(formatWarning({
      message: `Not resuming: the answer to ${question.id} is in the working tree, and the resumed job would not see it.`,
      hint: `Commit and push it, then run \`chant run resume --op ${named.op}\`.`,
    }));
    return 1;
  }
  if ((await pushLifecycleStatus({ cwd })).status !== "pushed") {
    console.error(formatWarning({
      message: "Not resuming: the answer did not reach the remote, so the resumed job would not see it.",
      hint: `Push chant/lifecycle, then run \`chant run resume --op ${named.op}\`.`,
    }));
    return 1;
  }
  const reports = (await resumeOpGates(named.op, named.gate)).filter((r) => r.environment === undefined);
  if (reports.length === 0) {
    console.error(formatInfo(`No pending fact for ${named.op} / ${named.gate} is waiting, so there is nothing to resume.`));
    return 0;
  }
  for (const r of reports) printReport(r);
  return reports.some((r) => r.status === "failed" || r.status === "no-token") ? 1 : 0;
}

/** What {@link resumeWaitingGates} reads. */
export interface ResumeWaitingOptions extends ResumeGateOptions {
  /** One op's gate ledger; absent, every gate ledger on `chant/lifecycle`. */
  op?: string;
  /** Only this gate's waiting job (#3854); absent, every gate's. */
  gate?: string;
}

/**
 * What `chant run resume` does, callable in process: read the gate ledgers
 * (`op`'s alone, when given) and start again each CI job that waits at a
 * gate an approval now answers. With `gate`, only that gate's job is touched,
 * so a caller that just approved one wave resumes that wave's job and no
 * other (#3854). The lifecycle ledger has to be readable
 * (`requireLifecycleLedger`).
 */
export async function resumeWaitingGates(opts: ResumeWaitingOptions = {}): Promise<GateResumeReport[]> {
  const { op, gate, ...rest } = opts;
  const ops = op ? [op] : (await listFilesInDir(GATES_DIR)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  const reports: GateResumeReport[] = [];
  for (const o of ops) reports.push(...(await resumeOpGates(o, gate, rest)));
  return reports;
}

/**
 * `chant run resume [--op <op>] [--gate <gate>] [--dry-run] [--json]`: the
 * scheduled job. Reads every gate ledger on `chant/lifecycle` (or `--op`'s),
 * and starts again each CI job that waits at a gate (or at `--gate` alone)
 * an approval now answers, or at a gate whose decision point now has an
 * answer that passes it (#3835), unless a wave already applied under that
 * approval (#3858). It also starts again the run of an apply under an
 * approval that stopped, once that run is gone. `--dry-run --json` starts
 * nothing and says, per gate, whether it would resume and why, for a product
 * that resumes in its own job.
 */
export async function runResumeCommand(ctx: CommandContext): Promise<number> {
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot read the gate ledgers: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const dryRun = ctx.args.dryRun === true;
  const reports = await resumeWaitingGates({
    ...(ctx.args.op ? { op: ctx.args.op } : {}),
    ...(ctx.args.gate ? { gate: ctx.args.gate } : {}),
    dryRun,
  });
  if (ctx.args.json) console.log(JSON.stringify({ dryRun, reports }, null, 2));
  else {
    for (const r of reports.filter((r) => r.status !== "not-approved")) printReport(r);
    const waiting = reports.filter((r) => r.status === "not-approved").length;
    const done = dryRun ? `${reports.filter((r) => r.resumable).length} would resume` : `${reports.filter((r) => r.status === "resumed").length} resumed`;
    console.error(formatInfo(`${done}, ${waiting} still waiting for an approval or a passing answer.`));
  }
  // A dry run reads; a missing token only leaves a stopped apply unchecked, which its report says.
  return reports.some((r) => r.status === "failed" || (!dryRun && r.status === "no-token")) ? 1 : 0;
}
