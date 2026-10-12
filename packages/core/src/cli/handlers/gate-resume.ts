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
 */

import {
  GATES_DIR,
  isPendingGateExpired,
  readGateLedger,
  type GateResolutionRecord,
  type PendingGateRecord,
} from "../../lifecycle/gate-ledger";
import { listFilesInDir, pushLifecycleStatus, requireLifecycleLedger } from "../../lifecycle/git";
import { parseGateSubject } from "../../op/gate-point";
import {
  isGateRunLocator,
  resolutionAnswering,
  resumeGateRun,
  resumeTokenFromEnv,
  type GateResumeOutcome,
} from "../../op/gate-resume";
import { pointGateResumable, type PointQuestionState } from "../../point-decision";
import type { ForgeFetch } from "../../pr-forge";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/** One waiting gate and what resuming it did. */
export interface GateResumeReport {
  op: string;
  gate: string;
  environment?: string;
  /** `resumed` and `skipped` come from the forge; the rest are decided before any call. */
  status: GateResumeOutcome["status"] | "not-approved" | "no-job" | "no-token" | "failed";
  message: string;
  approvedBy?: string;
  url?: string;
}

/** The newest pending fact per gate and environment: the facts a run still waits on. */
function standingFacts(pending: readonly PendingGateRecord[], gate?: string): PendingGateRecord[] {
  const newest = new Map<string, PendingGateRecord>();
  for (const p of pending) {
    if (gate !== undefined && p.gate !== gate) continue;
    const key = `${p.gate}\u0000${p.environment ?? ""}`;
    const prior = newest.get(key);
    if (!prior || new Date(p.timestamp).getTime() >= new Date(prior.timestamp).getTime()) newest.set(key, p);
  }
  return [...newest.values()];
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
}

/** Every question the workspace at `cwd` lists, by id, the lifecycle ledger's included. Empty when the workspace can't be read. */
export async function workspaceQuestions(cwd: string): Promise<Map<string, PointQuestionState>> {
  const { workspacePoints } = await import("../../workspace/points-cli");
  const doc = await workspacePoints({ cwd }).catch(() => undefined);
  if (!doc || !("questions" in doc)) return new Map();
  return new Map(doc.questions.map((q) => [q.id, { id: q.id, state: q.state, answer: q.answer, answeredBy: q.answeredBy, answeredOn: q.answeredOn }]));
}

/** Resume the job behind one standing pending fact, when an approval answers it. */
export async function resumeStanding(
  standing: PendingGateRecord,
  resolutions: readonly GateResolutionRecord[],
  opts: ResumeGateOptions = {},
  pending: readonly PendingGateRecord[] = [standing],
): Promise<GateResumeReport> {
  const base = {
    op: standing.op,
    gate: standing.gate,
    ...(standing.environment !== undefined ? { environment: standing.environment } : {}),
    ...(standing.resume?.url ? { url: standing.resume.url } : {}),
  };
  let approvedBy: { approvedBy: string };
  let since: string | undefined;
  if (standing.answer) {
    // A gate that asks a decision point waits on its question (#3835).
    const check = pointGateResumable(standing, opts.questions?.get(standing.answer.id));
    if (!check.resumable) return { ...base, status: "not-approved", message: check.message };
    approvedBy = { approvedBy: check.answeredBy };
    since = check.answeredOn ?? undefined;
  } else {
    const answer = resolutionAnswering(resolutions, standing, pending);
    if (!answer) return { ...base, status: "not-approved", message: "no approval answers it yet" };
    approvedBy = { approvedBy: answer.resolvedBy };
    since = answer.timestamp;
  }
  if (!isGateRunLocator(standing.resume)) {
    return { ...base, ...approvedBy, status: "no-job", message: "its pending fact names no CI job (it was recorded outside CI); run it again by hand" };
  }
  const loc = standing.resume;
  if (opts.dryRun) return { ...base, ...approvedBy, status: "skipped", message: `would resume ${loc.forge} run ${loc.run} (--dry-run)` };
  const token = resumeTokenFromEnv(loc.forge, opts.env ?? process.env);
  if (!token) {
    return {
      ...base,
      ...approvedBy,
      status: "no-token",
      message: `no token to call ${loc.forge} with: set CHANT_FORGE_TOKEN (or ${loc.forge === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN"})`,
    };
  }
  try {
    const outcome = await resumeGateRun(loc, { token, ...(since ? { since } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    return { ...base, ...approvedBy, status: outcome.status, message: outcome.status === "resumed" ? outcome.how : outcome.reason };
  } catch (err) {
    return { ...base, ...approvedBy, status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Resume every job waiting on `op`'s gates (or one gate) whose approval arrived. */
export async function resumeOpGates(op: string, gate: string | undefined, opts: ResumeGateOptions = {}): Promise<GateResumeReport[]> {
  const ledger = await readGateLedger(op);
  const now = opts.now ?? new Date().toISOString();
  const reports: GateResumeReport[] = [];
  const standing = standingFacts(ledger.pending, gate).filter((p) => !isPendingGateExpired(p, now));
  // Read the workspace's questions once, and only when a fact waits on one (#3835).
  const questions = opts.questions ?? (standing.some((p) => p.answer) ? await workspaceQuestions(process.cwd()) : undefined);
  for (const p of standing) reports.push(await resumeStanding(p, ledger.resolutions, { ...opts, ...(questions ? { questions } : {}) }, ledger.pending));
  return reports;
}

function printReport(r: GateResumeReport): void {
  const where = `${r.op} / ${r.gate}${r.environment !== undefined ? ` (${r.environment})` : ""}`;
  const by = r.approvedBy ? `, approved by ${r.approvedBy}` : "";
  const link = r.url ? ` ${r.url}` : "";
  if (r.status === "resumed") console.error(formatSuccess(`${where}${by}: ${r.message}${link}`));
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
 * answer that passes it (#3835).
 */
export async function runResumeCommand(ctx: CommandContext): Promise<number> {
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot read the gate ledgers: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const reports = await resumeWaitingGates({
    ...(ctx.args.op ? { op: ctx.args.op } : {}),
    ...(ctx.args.gate ? { gate: ctx.args.gate } : {}),
    dryRun: ctx.args.dryRun === true,
  });
  if (ctx.args.json) console.log(JSON.stringify({ reports }, null, 2));
  else {
    for (const r of reports.filter((r) => r.status !== "not-approved")) printReport(r);
    const waiting = reports.filter((r) => r.status === "not-approved").length;
    console.error(formatInfo(`${reports.filter((r) => r.status === "resumed").length} resumed, ${waiting} still waiting for an approval or a passing answer.`));
  }
  return reports.some((r) => r.status === "failed" || r.status === "no-token") ? 1 : 0;
}
