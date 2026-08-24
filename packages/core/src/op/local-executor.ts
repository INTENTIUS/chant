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

import type { OpConfig, PhaseDefinition, ActivityStep, GateStep, EffectStep, StepDefinition } from "./types";
import { resolveActivity, type ActivityFn, type ActivityProfile } from "./activity-registry";
import type { ReceiptReadResult } from "./receipt-store";

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
const isEffect = (s: StepDefinition): s is EffectStep => s.kind === "effect";

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

/** Find the first gate step anywhere in the Op (phases + onFailure, including
 * gates nested inside effect steps), if any. */
export function findGate(config: OpConfig): GateStep | undefined {
  const all = [...config.phases, ...(config.onFailure ?? [])];
  for (const phase of all) {
    for (const step of phase.steps) {
      if (isGate(step)) return step;
      if (isEffect(step)) {
        const nested = step.steps.find(isGate);
        if (nested) return nested;
      }
    }
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

/** A finished step: its record plus (on success) the activity's return value —
 * the effect-step path needs `receiptRead`'s result, not just its status. */
interface RanStep {
  record: StepRecord;
  result?: unknown;
}

/** Run one activity step with retry + timeout. Never throws — returns a record. */
async function runStep(
  step: ActivityStep,
  phaseName: string,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<RanStep> {
  const args = step.args ?? {};
  const base = { phase: phaseName, fn: step.fn, args };
  const start = Date.now();

  let fn: ActivityFn;
  try {
    fn = resolveActivity(activities, step.fn);
  } catch (err) {
    return { record: { ...base, status: "fail", durationMs: 0, error: errMessage(err) } };
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
      return { record, result };
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
  return { record: { ...base, status: "fail", durationMs: Date.now() - start, error: errMessage(lastErr) } };
}

// ── Effect steps (#1834) ──────────────────────────────────────────────────────

/** The step data the executor synthesizes to read a receipt through the store
 * activities (`receiptRead`/`receiptWrite` — provided by the receipt row's
 * lexicon, #1835, or a mock store in tests via `receiptActivities`). */
function receiptReadStep(step: EffectStep): ActivityStep {
  return {
    kind: "activity",
    fn: "receiptRead",
    args: {
      receipt: step.receipt,
      ...(step.expectation !== undefined ? { expectation: step.expectation } : {}),
    },
    profile: "fastIdempotent",
    outcomeAttribute: { name: "EffectApplied", from: "applied" },
  };
}

/** A skipped-record for a step that will not run. */
function skippedRecord(phaseName: string, fn: string, args?: Record<string, unknown>): StepRecord {
  return { phase: phaseName, fn, args: args ?? {}, status: "skipped", durationMs: 0 };
}

/**
 * Run one effect step: read-compare-run-write. On a match the nested steps are
 * recorded as skipped ("effect already applied") and nothing is written. On a
 * mismatch the nested steps run in authored order; only when every one
 * succeeds is the receipt written — last, once (the sole writer, #1703
 * decision 3). Any failure leaves the receipt untouched (stale), so the next
 * run re-proposes the effect.
 */
async function runEffectStep(
  step: EffectStep,
  phaseName: string,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<{ records: StepRecord[]; failed: boolean }> {
  const records: StepRecord[] = [];

  const read = await runStep(receiptReadStep(step), phaseName, activities, profiles, signal);
  records.push(read.record);
  if (read.record.status === "fail") return { records, failed: true };

  const result = read.result as Partial<ReceiptReadResult> | undefined;
  if (typeof result?.expectation !== "string") {
    records.push({
      phase: phaseName,
      fn: `effect:${step.receipt.name}`,
      args: {},
      status: "fail",
      durationMs: 0,
      error: "receiptRead returned no expectation — the receipt store activity must return { current, expectation }",
    });
    return { records, failed: true };
  }
  const expectation = result.expectation;

  if (result.current === expectation) {
    // Effect already applied — skip the nested steps, write nothing.
    for (const nested of step.steps) {
      if (nested.kind === "activity") records.push(skippedRecord(phaseName, nested.fn, nested.args));
    }
    return { records, failed: false };
  }

  // Gates are pre-flighted by findGate; only activities remain here.
  const nestedActivities = step.steps.filter(isActivity);
  for (let i = 0; i < nestedActivities.length; i++) {
    const ran = await runStep(nestedActivities[i], phaseName, activities, profiles, signal);
    records.push(ran.record);
    if (ran.record.status === "fail") {
      // Receipt left untouched (stale) — the next run re-proposes the effect.
      for (const skipped of nestedActivities.slice(i + 1)) {
        records.push(skippedRecord(phaseName, skipped.fn, skipped.args));
      }
      records.push(skippedRecord(phaseName, "receiptWrite"));
      return { records, failed: true };
    }
  }

  // Sole writer of the receipt: on success of every nested step, last.
  const wrote = await runStep(
    {
      kind: "activity",
      fn: "receiptWrite",
      args: { receipt: step.receipt, expectation },
      profile: "fastIdempotent",
    },
    phaseName,
    activities,
    profiles,
    signal,
  );
  records.push(wrote.record);
  return { records, failed: wrote.record.status === "fail" };
}

/** Run a phase. Throws PhaseFailure (with records so far) if any step fails. */
async function runPhase(
  phase: PhaseDefinition,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
): Promise<StepRecord[]> {
  // Defensive: gates are pre-flighted, but never execute one if it slips
  // through — including a gate nested inside an effect step.
  const gate =
    phase.steps.find(isGate) ??
    phase.steps.filter(isEffect).flatMap((e) => e.steps).find(isGate);
  if (gate) throw new LocalGateUnsupportedError(gate.signalName);

  if (phase.parallel) {
    const eff = phase.steps.find(isEffect);
    if (eff) {
      throw new Error(
        `effect step "${eff.receipt.name}" cannot run in a parallel phase — read-compare-run-write is ordered`,
      );
    }
    const steps = phase.steps.filter(isActivity);
    const records = (
      await Promise.all(steps.map((s) => runStep(s, phase.name, activities, profiles, signal)))
    ).map((r) => r.record);
    if (records.some((r) => r.status === "fail")) throw new PhaseFailure(records);
    return records;
  }

  const steps = phase.steps.filter((s): s is ActivityStep | EffectStep => !isGate(s));
  const records: StepRecord[] = [];

  const skipRemaining = (from: number) => {
    for (const skipped of steps.slice(from)) {
      if (isEffect(skipped)) {
        records.push(skippedRecord(phase.name, `effect:${skipped.receipt.name}`));
      } else {
        records.push(skippedRecord(phase.name, skipped.fn, skipped.args));
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (isEffect(step)) {
      const { records: effRecords, failed } = await runEffectStep(step, phase.name, activities, profiles, signal);
      records.push(...effRecords);
      if (failed) {
        skipRemaining(i + 1);
        throw new PhaseFailure(records);
      }
      continue;
    }
    const { record } = await runStep(step, phase.name, activities, profiles, signal);
    records.push(record);
    if (record.status === "fail") {
      // Mark the remaining steps in this phase as skipped, then abort.
      skipRemaining(i + 1);
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

  // Effect steps are ordered (read-compare-run-write): refuse them in a
  // parallel phase up front, with the phase named, rather than mid-run.
  for (const phase of [...config.phases, ...(config.onFailure ?? [])]) {
    const eff = phase.parallel ? phase.steps.find(isEffect) : undefined;
    if (eff) {
      throw new Error(
        `phase "${phase.name}": effect step "${eff.receipt.name}" cannot run in a ` +
          `parallel phase — read-compare-run-write is ordered`,
      );
    }
  }

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
