/**
 * `chant approve <op> <gate> --resume` and `chant run resume` (#3683): start
 * the CI job that waits at a gate again once its approval has arrived. See
 * `../../op/gate-resume.ts` for what each forge is asked and the token it
 * needs. Neither approves anything.
 */

import {
  GATES_DIR,
  isPendingGateExpired,
  readGateLedger,
  type GateResolutionRecord,
  type PendingGateRecord,
} from "../../lifecycle/gate-ledger";
import { listFilesInDir, requireLifecycleLedger } from "../../lifecycle/git";
import {
  isGateRunLocator,
  resolutionAnswering,
  resumeGateRun,
  resumeTokenFromEnv,
  type GateResumeOutcome,
} from "../../op/gate-resume";
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
}

/** Resume the job behind one standing pending fact, when an approval answers it. */
export async function resumeStanding(
  standing: PendingGateRecord,
  resolutions: readonly GateResolutionRecord[],
  opts: ResumeGateOptions = {},
): Promise<GateResumeReport> {
  const base = {
    op: standing.op,
    gate: standing.gate,
    ...(standing.environment !== undefined ? { environment: standing.environment } : {}),
    ...(standing.resume?.url ? { url: standing.resume.url } : {}),
  };
  const answer = resolutionAnswering(resolutions, standing);
  if (!answer) return { ...base, status: "not-approved", message: "no approval answers it yet" };
  const approvedBy = { approvedBy: answer.resolvedBy };
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
    const outcome = await resumeGateRun(loc, { token, since: answer.timestamp, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
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
  for (const standing of standingFacts(ledger.pending, gate)) {
    if (isPendingGateExpired(standing, now)) continue;
    reports.push(await resumeStanding(standing, ledger.resolutions, opts));
  }
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
 * `chant run resume [--op <op>] [--dry-run] [--json]`: the scheduled job.
 * Reads every gate ledger on `chant/lifecycle` (or `--op`'s), and starts
 * again each CI job that waits at a gate an approval now answers.
 */
export async function runResumeCommand(ctx: CommandContext): Promise<number> {
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot read the gate ledgers: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const ops = ctx.args.op
    ? [ctx.args.op]
    : (await listFilesInDir(GATES_DIR)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  const reports: GateResumeReport[] = [];
  for (const op of ops) reports.push(...(await resumeOpGates(op, undefined, { dryRun: ctx.args.dryRun === true })));
  if (ctx.args.json) console.log(JSON.stringify({ reports }, null, 2));
  else {
    for (const r of reports.filter((r) => r.status !== "not-approved")) printReport(r);
    const waiting = reports.filter((r) => r.status === "not-approved").length;
    console.error(formatInfo(`${reports.filter((r) => r.status === "resumed").length} resumed, ${waiting} still waiting for an approval.`));
  }
  return reports.some((r) => r.status === "failed" || r.status === "no-token") ? 1 : 0;
}
