/**
 * Local Op executor — runs an Op's phases in-process with no Temporal worker.
 *
 * A first-class peer to Temporal mode for dev loops, CI, and drift/observation
 * Ops. Provides phase sequencing, parallel phases, per-step retry + timeout via
 * activity profiles, `outcomeAttribute` capture, and `onFailure` compensation.
 * Gates and schedules are unsupported and rejected before any phase runs.
 *
 * The executor is deliberately decoupled from the Temporal lexicon: activity
 * implementations and profiles are passed in (loaded dynamically by the CLI),
 * so core never statically depends on `@intentius/chant-lexicon-temporal`.
 */

import type { OpConfig, PhaseDefinition, ActivityStep, GateStep, StepDefinition } from "./types";
import { resolveActivity, type ActivityFn, type ActivityProfile } from "./activity-registry";

// ── Records ─────────────────────────────────────────────────────────────────

export interface StepRecord {
  phase: string;
  fn: string;
  args: Record<string, unknown>;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  outcome?: { name: string; value: unknown };
  error?: string;
}

export interface OpRunResult {
  op: string;
  records: StepRecord[];
  totalMs: number;
  ok: boolean;
}

// ── Errors ────────────────────────────────────────────────────────────────��─

/** Thrown when an Op contains a gate (or schedule) that local mode cannot run. */
export class LocalGateUnsupportedError extends Error {
  constructor(public readonly signalName: string) {
    super(
      `gate "${signalName}" is not supported in local mode — gates and schedules ` +
        `need a durable runtime. Re-run with --temporal.`,
    );
    this.name = "LocalGateUnsupportedError";
  }
}

/** Thrown on terminal Op failure; carries the partial run result for rendering. */
export class OpRunFailure extends Error {
  constructor(public readonly result: OpRunResult) {
    super(`Op "${result.op}" failed`);
    this.name = "OpRunFailure";
  }
}

/** Internal: a phase aborted; carries records produced before the abort. */
class PhaseFailure extends Error {
  constructor(public readonly records: StepRecord[]) {
    super("phase failed");
    this.name = "PhaseFailure";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────��─

const DEFAULT_PROFILE = "fastIdempotent";
const FALLBACK_TIMEOUT_MS = 5 * 60_000;

const isActivity = (s: StepDefinition): s is ActivityStep => s.kind === "activity";
const isGate = (s: StepDefinition): s is GateStep => s.kind === "gate";

/** Parse a Temporal duration string ("5m", "30s", "1h30m", "100ms") to ms. */
export function parseDuration(s: string): number {
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    total += Number(m[1]) * units[m[2]];
    matched = true;
  }
  if (!matched) throw new Error(`unparseable duration: "${s}"`);
  return total;
}

/** Resolve a dot-path into a value; returns the whole value when path is absent. */
function resolvePath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
    value,
  );
}

/** Find the first gate step anywhere in the Op (phases + onFailure), if any. */
export function findGate(config: OpConfig): GateStep | undefined {
  const all = [...config.phases, ...(config.onFailure ?? [])];
  for (const phase of all) {
    const gate = phase.steps.find(isGate);
    if (gate) return gate;
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Race a single activity attempt against its start-to-close timeout. On timeout
 * (or when the run-level `parentSignal` aborts, e.g. Ctrl-C) the attempt's
 * `AbortSignal` fires so the activity can kill its child process, then the call
 * rejects so the retry loop can react. The losing promise is swallowed to keep
 * its eventual rejection from surfacing as an unhandled rejection.
 */
async function callWithTimeout(
  fn: ActivityFn,
  args: Record<string, unknown>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`activity timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const call = Promise.resolve(fn(args, controller.signal));
  call.catch(() => {}); // losing-race rejection must not become unhandled

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

// ── Step + phase execution ────────────────────────────────────────────────��─

/** Run one activity step with retry + timeout. Never throws — returns a record. */
async function runStep(
  step: ActivityStep,
  phaseName: string,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<StepRecord> {
  const args = step.args ?? {};
  const base = { phase: phaseName, fn: step.fn, args };
  const start = Date.now();

  let fn: ActivityFn;
  try {
    fn = resolveActivity(activities, step.fn);
  } catch (err) {
    return { ...base, status: "fail", durationMs: 0, error: errMessage(err) };
  }

  const profile = profiles[step.profile ?? DEFAULT_PROFILE] ?? {};
  const timeoutMs = profile.startToCloseTimeout
    ? parseDuration(profile.startToCloseTimeout)
    : FALLBACK_TIMEOUT_MS;
  const maxAttempts =
    profile.retry?.maximumAttempts && profile.retry.maximumAttempts > 0
      ? profile.retry.maximumAttempts
      : 1;
  const initial = profile.retry?.initialInterval ? parseDuration(profile.retry.initialInterval) : 0;
  const backoff = profile.retry?.backoffCoefficient ?? 1;
  const maxInterval = profile.retry?.maximumInterval
    ? parseDuration(profile.retry.maximumInterval)
    : Infinity;
  const nonRetryable = profile.retry?.nonRetryableErrorTypes ?? [];

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callWithTimeout(fn, args, timeoutMs, signal);
      const record: StepRecord = { ...base, status: "ok", durationMs: Date.now() - start };
      if (step.outcomeAttribute) {
        record.outcome = {
          name: step.outcomeAttribute.name,
          value: resolvePath(result, step.outcomeAttribute.from),
        };
      }
      return record;
    } catch (err) {
      lastErr = err;
      // Stop retrying on abort (Ctrl-C / timeout cascade) or a non-retryable error.
      const fatal =
        signal?.aborted || (err instanceof Error && nonRetryable.includes(err.name));
      if (!fatal && attempt < maxAttempts) {
        const wait = Math.min(initial * Math.pow(backoff, attempt - 1), maxInterval);
        if (wait > 0) await sleep(wait);
        continue;
      }
      break;
    }
  }
  return { ...base, status: "fail", durationMs: Date.now() - start, error: errMessage(lastErr) };
}

/** Run a phase. Throws PhaseFailure (with records so far) if any step fails. */
async function runPhase(
  phase: PhaseDefinition,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<StepRecord[]> {
  // Defensive: gates are pre-flighted, but never execute one if it slips through.
  const gate = phase.steps.find(isGate);
  if (gate) throw new LocalGateUnsupportedError(gate.signalName);

  const steps = phase.steps.filter(isActivity);

  if (phase.parallel) {
    const records = await Promise.all(
      steps.map((s) => runStep(s, phase.name, activities, profiles, signal)),
    );
    if (records.some((r) => r.status === "fail")) throw new PhaseFailure(records);
    return records;
  }

  const records: StepRecord[] = [];
  for (let i = 0; i < steps.length; i++) {
    const record = await runStep(steps[i], phase.name, activities, profiles, signal);
    records.push(record);
    if (record.status === "fail") {
      // Mark the remaining steps in this phase as skipped, then abort.
      for (const skipped of steps.slice(i + 1)) {
        records.push({
          phase: phase.name,
          fn: skipped.fn,
          args: skipped.args ?? {},
          status: "skipped",
          durationMs: 0,
        });
      }
      throw new PhaseFailure(records);
    }
  }
  return records;
}

// ── Public API ────────────────────────────────────────────────────────────��─

/**
 * Execute an Op locally. Resolves with the run result on success; rejects with
 * `OpRunFailure` (carrying the partial result) on terminal failure, after
 * running any `onFailure` phases in reverse order. Throws
 * `LocalGateUnsupportedError` up front if the Op contains a gate.
 */
export async function runOpLocally(
  config: OpConfig,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<OpRunResult> {
  const gate = findGate(config);
  if (gate) throw new LocalGateUnsupportedError(gate.signalName);

  const records: StepRecord[] = [];
  const start = Date.now();

  try {
    for (const phase of config.phases) {
      if (signal?.aborted) throw new PhaseFailure([]);
      records.push(...(await runPhase(phase, activities, profiles, signal)));
    }
  } catch (err) {
    if (err instanceof PhaseFailure) records.push(...err.records);

    // Compensation: run onFailure phases in reverse order (best-effort). Skipped
    // on abort (Ctrl-C) — the user asked to stop, so don't start new work.
    if (!signal?.aborted) {
      for (const phase of [...(config.onFailure ?? [])].reverse()) {
        try {
          records.push(...(await runPhase(phase, activities, profiles, signal)));
        } catch (compErr) {
          if (compErr instanceof PhaseFailure) records.push(...compErr.records);
        }
      }
    }

    throw new OpRunFailure({ op: config.name, records, totalMs: Date.now() - start, ok: false });
  }

  return { op: config.name, records, totalMs: Date.now() - start, ok: true };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
