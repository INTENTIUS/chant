/**
 * restoreDrill (#5450): restore the newest backup of a declared store into a
 * scratch environment, run the checks the Op declares, tear the scratch
 * environment down, and record how long it took and how old the data was.
 *
 * One activity rather than four steps, so the clock that measures RTO runs in
 * one process and the teardown cannot be skipped by a step that failed before
 * it. The stages inside it are the ones a drill has: pick the backup, restore,
 * check, tear down, record. What each measures is defined in
 * `../../lifecycle/drill-record.ts`.
 *
 * A drill that misses a target, fails a check or leaves its scratch
 * environment behind throws after it has recorded itself, with the
 * measurements attached (`withKnownOutputs`), so the run ledger holds the
 * numbers of a failed drill too.
 */

import { randomUUID } from "node:crypto";
import { appendDrillRecord } from "../../lifecycle/drill-ledger";
import {
  DRILL_STORE_KINDS,
  describeTargets,
  drillOutcome,
  evaluateTargets,
  formatSpan,
  parseDrillTargets,
  type DrillCheckResult,
  type DrillRecord,
  type DrillTargetsInput,
} from "../../lifecycle/drill-record";
import { sleep } from "../activity-runtime";
import { withKnownOutputs } from "../activity-failure";
import { httpCheck, type HttpFetch } from "./http-check";
import { defaultDrillExec, drillAdapterFor, sourceNames, type DrillAdapter, type DrillBackup, type DrillExec, type DrillRestored, type DrillStoreSpec } from "./restore-drill-stores";

export type { DrillStoreSpec } from "./restore-drill-stores";

/**
 * A check of the restored store. `url` and `cmd` may name `${DRILL_ENDPOINT}`
 * and `${DRILL_SCRATCH}` in `url`; a command also sees them as environment
 * variables, with `DRILL_STORE`.
 */
export type DrillCheck =
  | { name: string; kind: "http"; url: string; status?: number; contains?: string; retries?: number; intervalMs?: number }
  | {
      name: string;
      kind: "command";
      /** Run with `sh -c`. Exit 0 passes, unless `expect` says more. */
      cmd: string;
      /** What stdout must show: its trimmed text, a substring, or a number at least this large (a row count). */
      expect?: { equals?: string; contains?: string; atLeast?: number };
      retries?: number;
      intervalMs?: number;
    };

export interface RestoreDrillArgs {
  store: DrillStoreSpec;
  /** The environment the store lives in; the drill is recorded under it. Default `local`. */
  env?: string;
  /** The Op's name, copied onto the record. */
  op?: string;
  /** The scratch environment's name. Must start with `drill-` and differ from the store's own. Default `drill-<store>-<minute>`. */
  scratch?: string;
  checks?: DrillCheck[];
  /** `rto` and `rpo` as durations, `"4h"` and `"15m"`. A target left out is not checked. */
  targets?: DrillTargetsInput;
  /** Where the ledger is written from. Default: the working directory. */
  cwd?: string;
  /** Test seams. */
  _exec?: DrillExec;
  _adapter?: DrillAdapter;
  _fetch?: HttpFetch;
  _now?: () => number;
  _id?: () => string;
  _record?: (record: DrillRecord) => Promise<unknown>;
}

export interface RestoreDrillResult {
  id: string;
  store: string;
  outcome: DrillRecord["outcome"];
  rtoMs: number | null;
  restoreMs: number | null;
  rpoMs: number | null;
  met: boolean | null;
  shortfall: DrillRecord["shortfall"];
  checksPassed: number;
  checksTotal: number;
  backupId: string | null;
  backupAt: string | null;
  tornDown: boolean;
  record: DrillRecord;
}

const SCRATCH = /^drill-[a-z0-9][a-z0-9-]{0,45}$/;
const STORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function defaultScratch(store: string, at: number): string {
  const stamp = new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const slug = store.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "store";
  return `drill-${slug}-${stamp}`;
}

/** Why the arguments cannot start a drill, checked before anything is created. */
export function drillProblems(args: RestoreDrillArgs, scratch: string): string[] {
  const out: string[] = [];
  const store = args.store as { kind?: unknown; name?: unknown };
  if (!store || typeof store !== "object") return ["store: name the store to drill"];
  if (!DRILL_STORE_KINDS.includes(store.kind as never)) out.push(`store.kind: ${JSON.stringify(store.kind)} is not one of ${DRILL_STORE_KINDS.join(", ")}`);
  if (typeof store.name !== "string" || !STORE_NAME.test(store.name)) out.push(`store.name: ${JSON.stringify(store.name)} must be a name of letters, digits, dot, dash and underscore`);
  if (!SCRATCH.test(scratch)) out.push(`scratch: ${JSON.stringify(scratch)} must start with "drill-" and use lowercase letters, digits and dashes, so a drill can never be pointed at a real store`);
  if (out.length === 0 && sourceNames(args.store).includes(scratch)) out.push(`scratch: ${JSON.stringify(scratch)} is the store itself`);
  const names = new Set<string>();
  for (const c of args.checks ?? []) {
    if (!c.name) out.push("checks: every check needs a name");
    else if (names.has(c.name)) out.push(`checks: two checks are named ${JSON.stringify(c.name)}`);
    names.add(c.name);
    const kind = (c as { kind?: unknown }).kind;
    if (kind !== "http" && kind !== "command") out.push(`checks: ${JSON.stringify((c as { name?: unknown }).name)} has kind ${JSON.stringify(kind)}, not http or command`);
  }
  return out;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(DRILL_[A-Z]+)\}/g, (_m, k: string) => vars[k] ?? "");
}

function expectProblem(stdout: string, expect: NonNullable<Extract<DrillCheck, { kind: "command" }>["expect"]>): string | undefined {
  const out = stdout.trim();
  if (expect.equals !== undefined && out !== expect.equals) return `printed ${JSON.stringify(out.slice(0, 80))}, wanted ${JSON.stringify(expect.equals)}`;
  if (expect.contains !== undefined && !out.includes(expect.contains)) return `output lacks ${JSON.stringify(expect.contains)}`;
  if (expect.atLeast !== undefined) {
    const n = Number(out);
    if (Number.isNaN(n)) return `printed ${JSON.stringify(out.slice(0, 80))}, not a number`;
    if (n < expect.atLeast) return `printed ${n}, wanted at least ${expect.atLeast}`;
  }
  return undefined;
}

async function runCheck(
  check: DrillCheck,
  vars: Record<string, string>,
  exec: DrillExec,
  fetchFn: HttpFetch | undefined,
  now: () => number,
  signal?: AbortSignal,
): Promise<DrillCheckResult> {
  const began = now();
  const done = (ok: boolean, detail?: string): DrillCheckResult => ({ name: check.name, kind: check.kind, ok, durationMs: Math.max(0, now() - began), ...(detail ? { detail } : {}) });
  try {
    if (check.kind === "http") {
      const res = await httpCheck(
        { url: fill(check.url, vars), ...(check.status !== undefined ? { status: check.status } : {}), ...(check.contains !== undefined ? { contains: check.contains } : {}), retries: check.retries ?? 0, intervalMs: check.intervalMs ?? 1000 },
        signal,
        fetchFn,
      );
      return done(true, `status ${res.status}`);
    }
    let last = "";
    for (let attempt = 0; attempt <= (check.retries ?? 0); attempt++) {
      try {
        const { stdout } = await exec(["sh", "-c", check.cmd], { env: vars });
        const problem = check.expect ? expectProblem(stdout, check.expect) : undefined;
        if (!problem) return done(true, stdout.trim().slice(0, 120) || undefined);
        last = problem;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (attempt < (check.retries ?? 0)) await sleep(check.intervalMs ?? 1000, signal);
    }
    return done(false, last);
  } catch (err) {
    return done(false, err instanceof Error ? err.message : String(err));
  }
}

/** The default recorder: append to the ledger, then push it as a run's own record is. A push that does not land is reported, not fatal; the drill stays on the local branch. */
function recordAndPush(cwd: string | undefined): (record: DrillRecord) => Promise<void> {
  return async (record) => {
    const opts = cwd ? { cwd } : undefined;
    await appendDrillRecord(record, opts);
    const { pushLifecycleReport } = await import("../../lifecycle/git");
    const { pushWarning } = await pushLifecycleReport(opts);
    if (pushWarning) console.error(`restore drill ${record.store}: recorded locally. ${pushWarning}`);
  };
}

/**
 * Run one restore drill. Resolves when the drill passed; rejects, after
 * recording, when it failed, missed a target or left its scratch environment
 * behind.
 */
export async function restoreDrill(args: RestoreDrillArgs, signal?: AbortSignal): Promise<RestoreDrillResult> {
  const clock = args._now ?? Date.now;
  const scratch = args.scratch ?? defaultScratch((args.store as { name?: string })?.name ?? "store", clock());
  const problems = drillProblems(args, scratch);
  if (problems.length > 0) throw new Error(`restoreDrill: ${problems.join("; ")}`);
  const targets = parseDrillTargets(args.targets);
  const exec = args._exec ?? defaultDrillExec;
  const adapter = args._adapter ?? drillAdapterFor(args.store, exec);
  const env = args.env ?? "local";

  const started = clock();
  let backup: DrillBackup | null = null;
  let restored: DrillRestored | undefined;
  let restoreStarted: number | undefined;
  let restoreEnded: number | undefined;
  let checksEnded: number | undefined;
  let error: string | undefined;
  const checks: DrillCheckResult[] = [];
  let attempted = false;

  try {
    backup = await adapter.newestBackup();
    if (signal?.aborted) throw new Error("aborted");
    attempted = true;
    restoreStarted = clock();
    restored = await adapter.restore(backup, scratch);
    restoreEnded = clock();
    const vars: Record<string, string> = { DRILL_STORE: args.store.name, DRILL_SCRATCH: scratch, DRILL_ENDPOINT: restored.endpoint ?? "" };
    for (const check of args.checks ?? []) checks.push(await runCheck(check, vars, exec, args._fetch, clock, signal));
    checksEnded = clock();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    attempted = attempted || restoreStarted !== undefined;
  }

  let tornDown = true;
  let tearDownError: string | undefined;
  if (attempted) {
    try {
      await adapter.teardown(scratch);
    } catch (err) {
      tornDown = false;
      tearDownError = err instanceof Error ? err.message : String(err);
    }
  }

  const checksOk = checks.every((c) => c.ok);
  const rpoMs = backup && restoreStarted !== undefined ? Math.max(0, restoreStarted - Date.parse(backup.at)) : null;
  const restoreMs = restoreStarted !== undefined && restoreEnded !== undefined ? restoreEnded - restoreStarted : null;
  const rtoMs = error === undefined && checksOk && restoreStarted !== undefined && checksEnded !== undefined ? checksEnded - restoreStarted : null;
  const verdict = evaluateTargets({ rtoMs, rpoMs }, targets);
  const outcome = drillOutcome(checksOk, error !== undefined, verdict.met);
  const ended = clock();

  const record: DrillRecord = {
    version: 1,
    id: (args._id ?? randomUUID)(),
    store: args.store.name,
    kind: args.store.kind,
    env,
    ...(args.op ? { op: args.op } : {}),
    scratch,
    started: new Date(started).toISOString(),
    ended: new Date(ended).toISOString(),
    backup,
    rtoMs,
    restoreMs,
    rpoMs,
    targets,
    met: verdict.met,
    shortfall: verdict.shortfall,
    outcome,
    checks,
    ...(error !== undefined ? { error } : {}),
    tornDown,
    ...(tearDownError !== undefined ? { tearDownError } : {}),
  };
  const result: RestoreDrillResult = {
    id: record.id,
    store: record.store,
    outcome,
    rtoMs,
    restoreMs,
    rpoMs,
    met: verdict.met,
    shortfall: verdict.shortfall,
    checksPassed: checks.filter((c) => c.ok).length,
    checksTotal: checks.length,
    backupId: backup?.id ?? null,
    backupAt: backup?.at ?? null,
    tornDown,
    record,
  };

  try {
    await (args._record ?? recordAndPush(args.cwd))(record);
  } catch (err) {
    throw withKnownOutputs(new Error(`restore drill ${record.store} measured RTO ${rtoMs === null ? "n/a" : formatSpan(rtoMs)} and RPO ${rpoMs === null ? "n/a" : formatSpan(rpoMs)} but could not record them: ${err instanceof Error ? err.message : String(err)}`), { ...result });
  }

  const reasons: string[] = [];
  if (error !== undefined) reasons.push(`failed: ${error}`);
  for (const c of checks.filter((c) => !c.ok)) reasons.push(`check ${c.name} failed${c.detail ? `: ${c.detail}` : ""}`);
  if (outcome === "missed") reasons.push(describeTargets(record.store, { rtoMs, rpoMs }, targets).replace(/^restore drill [^:]*: /, ""));
  if (!tornDown) reasons.push(`scratch ${scratch} was not torn down: ${tearDownError}`);
  if (reasons.length > 0) {
    throw withKnownOutputs(new Error(`restore drill ${record.store} ${outcome === "passed" ? "left scratch behind" : outcome}: ${reasons.join("; ")}`), { ...result });
  }
  return result;
}
