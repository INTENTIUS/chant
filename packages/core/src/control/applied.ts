/**
 * The apply outcome a member's dispatch carries, and the control repo's
 * record of it (#4617).
 *
 * A member that applies through op waves tells the control repo once the
 * last wave ran, whatever the waves did: the dispatch carries the outcome
 * the wave jobs' outcome files add up to ({@link applyOutcomeOf}). The
 * control repo's pipeline appends one `control-applied` line per dispatch to
 * `_control/applied.jsonl` on its `chant/lifecycle`, beside the entries
 * (./records.ts), and runs the member's dependents only when something
 * applied. A pull request note reads the newest apply of each member from
 * there to mark a cross-stack edge stale or current (./edges.ts).
 *
 * This module imports `node:crypto` and the outcome rule alone; the git
 * port loads on first use, so a product bundle can carry it.
 */

import { createHash } from "node:crypto";
import { passesThrough, type WaveMemberOutcome } from "../wave-blocked";
import { CONTROL_LEDGER_DIR, type ControlLedgerPort } from "./records";
import { CONTROL_APPLY_OUTCOMES, CONTROL_OUTCOME_VAR, CONTROL_RUNS_DEPENDENTS, type ControlApplyOutcome } from "./dispatch";

export { CONTROL_APPLY_OUTCOMES, CONTROL_OUTCOME_VAR, CONTROL_RUNS_DEPENDENTS, type ControlApplyOutcome };

/** The outcome, and the counts behind it. */
export interface ApplyOutcomeSummary {
  outcome: ControlApplyOutcome;
  /** The runs that applied, sorted. */
  applied: string[];
  /** Each status with how many runs ended in it. */
  counts: Record<string, number>;
}

/** The outcome of a set of runs, from each one's newest outcome (`earlierWaveOutcomes` over every wave). */
export function applyOutcomeOf(members: ReadonlyMap<string, WaveMemberOutcome>): ApplyOutcomeSummary {
  const counts: Record<string, number> = {};
  const applied: string[] = [];
  let through = 0;
  let waiting = false;
  for (const [name, o] of members) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
    if (o.status === "applied") applied.push(name);
    if (passesThrough(o)) through++;
    if (o.status === "waiting" || (o.status === "blocked" && o.by !== undefined && members.get(o.by)?.status === "waiting")) waiting = true;
  }
  applied.sort();
  const all = members.size;
  let outcome: ControlApplyOutcome;
  if (all === 0) outcome = "failed";
  else if (applied.length > 0) outcome = through === all ? "applied" : "partial";
  else if (through === all) outcome = "unchanged";
  else outcome = waiting ? "waiting" : "failed";
  return { outcome, applied, counts };
}

/** The file the apply records are kept in, beside the entries. */
export const CONTROL_APPLIED_FILE = "applied.jsonl";
export const CONTROL_APPLIED_KIND = "control-applied";

/** One line of `_control/applied.jsonl`: one dispatch the control repo took. */
export interface ControlAppliedRecord {
  version: 1;
  kind: typeof CONTROL_APPLIED_KIND;
  /** The member's name in the control repo's workspace. */
  member: string;
  op: string;
  /** The member's commit the waves ran at. */
  sha: string;
  outcome: ControlApplyOutcome;
  /** When the control repo took the dispatch, ISO 8601. */
  at: string;
  /** sha256 over the canonical JSON of every other field. */
  digest: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA = /^[0-9a-f]{7,64}$/;

function digestOf(fields: Omit<ControlAppliedRecord, "digest">): string {
  const keys = Object.keys(fields).sort() as Array<keyof typeof fields>;
  return `sha256:${createHash("sha256").update(JSON.stringify(Object.fromEntries(keys.map((k) => [k, fields[k]])))).digest("hex")}`;
}

/** The problems with one parsed line, or [] when it is a record. */
export function controlAppliedProblems(v: unknown): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return ["not an object"];
  const r = v as Record<string, unknown>;
  const out: string[] = [];
  if (r.version !== 1) out.push("version must be 1");
  if (r.kind !== CONTROL_APPLIED_KIND) out.push(`kind must be ${CONTROL_APPLIED_KIND}`);
  if (!(typeof r.member === "string" && NAME.test(r.member))) out.push("member must be a member's name");
  if (!(typeof r.op === "string" && NAME.test(r.op))) out.push("op must be an Op's name");
  if (!(typeof r.sha === "string" && SHA.test(r.sha))) out.push("sha must be a commit sha");
  if (!CONTROL_APPLY_OUTCOMES.includes(r.outcome as ControlApplyOutcome)) out.push(`outcome must be one of ${CONTROL_APPLY_OUTCOMES.join(", ")}`);
  if (!(typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)))) out.push("at must be a time");
  if (typeof r.digest !== "string") out.push("digest is missing");
  else if (out.length === 0) {
    const { digest: _d, ...rest } = r as unknown as ControlAppliedRecord;
    if (digestOf(rest) !== r.digest) out.push("digest does not match the record");
  }
  return out;
}

/** Every line of the file that is a record; the rest are counted as malformed. */
export function parseControlApplied(text: string | null | undefined): { records: ControlAppliedRecord[]; malformed: number } {
  const records: ControlAppliedRecord[] = [];
  let malformed = 0;
  for (const raw of (text ?? "").split("\n")) {
    if (!raw.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      malformed++;
      continue;
    }
    if (controlAppliedProblems(v).length > 0) malformed++;
    else records.push(v as ControlAppliedRecord);
  }
  return { records, malformed };
}

/** Each member's newest record whose outcome applied something ({@link CONTROL_RUNS_DEPENDENTS}). */
export function latestControlApplies(records: readonly ControlAppliedRecord[]): Map<string, ControlAppliedRecord> {
  const out = new Map<string, ControlAppliedRecord>();
  for (const r of records) {
    if (!CONTROL_RUNS_DEPENDENTS.includes(r.outcome)) continue;
    const had = out.get(r.member);
    if (!had || Date.parse(had.at) <= Date.parse(r.at)) out.set(r.member, r);
  }
  return out;
}

/** The control repo's `_control/applied.jsonl` on its local `chant/lifecycle`, under the member prefix of `cwd`. */
export function gitControlAppliedLedger(opts: { cwd?: string } = {}): ControlLedgerPort {
  return {
    async read() {
      const { readBlobFromPath } = await import("../lifecycle/git");
      return readBlobFromPath(CONTROL_LEDGER_DIR, CONTROL_APPLIED_FILE, opts);
    },
    async append(line, message) {
      const { appendLedgerLine } = await import("../lifecycle/git");
      return appendLedgerLine(CONTROL_LEDGER_DIR, CONTROL_APPLIED_FILE, line, message, opts);
    },
  };
}

/** Appends one record of a dispatch the control repo took. Does not push. */
export async function recordControlApplied(
  port: ControlLedgerPort,
  d: { member: string; op: string; sha: string; outcome: ControlApplyOutcome },
  opts: { now?: () => Date } = {},
): Promise<{ record: ControlAppliedRecord; commit: string }> {
  const fields: Omit<ControlAppliedRecord, "digest"> = {
    version: 1,
    kind: CONTROL_APPLIED_KIND,
    member: d.member,
    op: d.op,
    sha: d.sha,
    outcome: d.outcome,
    at: (opts.now ?? (() => new Date()))().toISOString(),
  };
  const record: ControlAppliedRecord = { ...fields, digest: digestOf(fields) };
  const problems = controlAppliedProblems(record);
  if (problems.length > 0) throw new Error(`not a control apply record: ${problems.join(", ")}`);
  const commit = await port.append(JSON.stringify(record), `Control: ${d.member} ${d.outcome} at ${d.sha.slice(0, 12)}`);
  return { record, commit };
}

/**
 * The control repo's step's call (`controlDependentsScript`): records the
 * dispatch the environment carries and pushes `chant/lifecycle`. Returns
 * what it wrote, or why it wrote nothing. A push that fails is a warning:
 * the dependents still run.
 */
export async function recordControlAppliedFromEnv(
  opts: { cwd?: string; env?: Record<string, string | undefined>; now?: () => Date } = {},
): Promise<{ recorded?: ControlAppliedRecord; skipped?: string; pushWarning?: string }> {
  const env = opts.env ?? process.env;
  const member = env.CHANT_CONTROL_MEMBER ?? "";
  const op = env.CHANT_CONTROL_OP ?? "";
  const sha = env.CHANT_CONTROL_SHA ?? "";
  const outcome = env[CONTROL_OUTCOME_VAR] ?? "";
  if (!outcome) return { skipped: "the dispatch carries no outcome" };
  if (!CONTROL_APPLY_OUTCOMES.includes(outcome as ControlApplyOutcome)) return { skipped: `the dispatch's outcome "${outcome}" is not one chant knows` };
  if (!SHA.test(sha)) return { skipped: "the dispatch names no commit sha" };
  const { record } = await recordControlApplied(gitControlAppliedLedger({ cwd: opts.cwd }), { member, op, sha, outcome: outcome as ControlApplyOutcome }, opts.now ? { now: opts.now } : {});
  const { pushLifecycleReport } = await import("../lifecycle/git");
  const pushed = await pushLifecycleReport({ ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  return { recorded: record, ...(pushed.pushWarning ? { pushWarning: pushed.pushWarning } : {}) };
}
