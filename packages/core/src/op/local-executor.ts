/**
 * Local Op executor — runs an Op's phases in this process.
 *
 * The default runtime (#2121), and the one dev loops, CI, and drift/observation
 * Ops use. Provides phase sequencing, parallel phases, per-step retry + timeout via
 * activity profiles, `outcomeAttribute` capture, and `onFailure` compensation.
 *
 * A gate is a fact, not a wait (#2119). Reaching one, the executor consults the
 * gate ledger through `./gate.ts`: a resolution newer than the gate's newest
 * pending fact lets the step pass, carrying the approver onto its record;
 * anything else records the pending fact and ends the run with status `gated`.
 * No later phase runs and `onFailure` does not run — a gate is not a failure,
 * and there is nothing to compensate for. The next run re-evaluates from the
 * ledger, so `chant approve <op> <gate>` followed by `chant run <op>` is the
 * whole loop.
 *
 * The executor is deliberately decoupled from any lexicon: activity
 * implementations and profiles are passed in (loaded dynamically by the CLI),
 * so core never statically depends on one.
 */

import { outcomeAttributesOf } from "./types";
import type { OpConfig, PhaseDefinition, ActivityStep, GateStep, EffectStep, StepDefinition } from "./types";
import { resolveActivity, type ActivityFn, type ActivityProfile } from "./activity-registry";
import type { ReceiptReadResult } from "./receipt-store";
import { isStepOutputRef } from "./step-output-ref";
import { parseDuration } from "./duration";
import { evaluateGate, gitGateLedgerPort, type GateCheck, type GateLedgerPort } from "./gate";
import { gateName } from "./gate-name";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";
import { appendRunRecord, buildRunRecord } from "../lifecycle/run-ledger";
import type { OpRunRecord } from "./runtime";
import { randomUUID } from "node:crypto";

export { parseDuration } from "./duration";

// ── Records ─────────────────────────────────────────────────────────────────

export interface StepRecord {
  phase: string;
  fn: string;
  /**
   * Present for a local-executor record. A runtime that reconstructs records
   * from its own run history may not have an activity's scheduled input to
   * hand, and omits the field rather than guessing at it.
   */
  args?: Record<string, unknown>;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  /**
   * The first outcome attribute the step published, kept singular because a
   * step publishing one is the ordinary case and every reader of this field
   * predates the plural form. {@link StepRecord.outcomes} is the whole list.
   */
  outcome?: { name: string; value: unknown };
  /** Every outcome attribute the step published, in authored order (#2105). Absent when it published none. */
  outcomes?: Array<{ name: string; value: unknown }>;
  error?: string;
  /** Set on a `gate` step that passed (#2119): who resolved it, when, and at what address. */
  approval?: { gate: string; resolvedBy: string; timestamp: string; url?: string };
}

export interface OpRunResult {
  op: string;
  records: StepRecord[];
  totalMs: number;
  /**
   * Three-state outcome (#2119). `gated` is neither success nor failure: the
   * run reached a gate nobody has approved, recorded the fact, and stopped.
   * The CLI exits 3 for it so CI can tell "waiting on a human" from "broken".
   *
   * Written to the run ledger as the record's own `status` (#2118).
   */
  status: "ok" | "fail" | "gated";
  /** ISO-8601 start of this run. */
  startedAt: string;
  /** Present when `status === "gated"`: the pending fact the run ended on. */
  gate?: PendingGateRecord;
  /**
   * Present when `status === "gated"` and this run's own append tried to push:
   * whether it reached the remote (#2310). Absent when the run stopped on a
   * pending fact an earlier run had already recorded — nothing was pushed
   * this run.
   */
  gatePushed?: boolean;
  /** Set when `gatePushed` is false: why, in one line. */
  gatePushWarning?: string;
  /**
   * The run's ledger record (#2118) — always built, whether or not it was
   * appended. `chant run <op> --json` prints exactly this, so what a caller
   * reads on stdout and what a later `readRunLedger` reads back are the same
   * document.
   */
  record: OpRunRecord;
}

// ── Errors ────────────────────────────────────────────────────────────────��─

/**
 * Thrown on terminal Op failure; carries the partial run result for rendering.
 *
 * `cause` is what actually went wrong (#2301). Before it, this class was the
 * end of the line for any error that was not a `PhaseFailure` — the executor
 * caught it, built an `OpRunFailure` from the records it had, and never
 * referenced the error again. Anything thrown outside a step's own
 * error-capturing path therefore reached the operator as `Op "x" failed` and
 * nothing else: no error line, no failing step, exit 1. That is how a gate
 * whose ledger write died on a CI checkout with no `user.email` produced no
 * text naming git, the ledger, or the identity, on INTENTIUS/choudoufu#1026.
 */
export class OpRunFailure extends Error {
  /** The error the run actually died on, when it was not a step's own failure. */
  public readonly cause?: unknown;

  constructor(
    public readonly result: OpRunResult,
    options?: { cause?: unknown },
  ) {
    super(`Op "${result.op}" failed`);
    this.name = "OpRunFailure";
    // Assigned rather than passed to `super` — the lib this package compiles
    // against predates Error's `options` parameter.
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** Internal: a phase aborted; carries records produced before the abort. */
class PhaseFailure extends Error {
  constructor(public readonly records: StepRecord[]) {
    super("phase failed");
    this.name = "PhaseFailure";
  }
}

/** Internal: a phase stopped on an unapproved gate. Not a failure — no compensation follows it. */
class GateStop extends Error {
  constructor(
    public readonly records: StepRecord[],
    public readonly pending: PendingGateRecord,
    public readonly phase: string,
    /** Whether this run's own append reached the remote — see {@link OpRunResult.gatePushed}. */
    public readonly pushed?: boolean,
    public readonly pushWarning?: string,
  ) {
    super(`gate "${pending.gate}" is pending approval`);
    this.name = "GateStop";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────��─

const DEFAULT_PROFILE = "fastIdempotent";

/**
 * The phase a synthetic failure record is filed under when the error did not
 * come from a step (#2301) — a ledger write, an abort, a malformed phase.
 * Named rather than blank so a reader of `--json` or of the run ledger can
 * tell it apart from an authored phase.
 */
const UNATTRIBUTED_PHASE = "run";
const FALLBACK_TIMEOUT_MS = 5 * 60_000;

const isActivity = (s: StepDefinition): s is ActivityStep => s.kind === "activity";
const isGate = (s: StepDefinition): s is GateStep => s.kind === "gate";
const isEffect = (s: StepDefinition): s is EffectStep => s.kind === "effect";

/** Resolve a dot-path into a value; returns the whole value when path is absent. */
function resolvePath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
    value,
  );
}

/**
 * Deep-walk `value`, replacing every {@link StepOutputRef} with the recorded
 * result of its producer step, resolved through the ref's optional dot-path
 * exactly like the serializer's compiled `__rN?.path?.segments` (chant #1290)
 * — `resolvePath` gives the same "undefined intermediate resolves to
 * undefined, never throws" semantics. A reference to a step whose result
 * isn't in `resultsById` (never ran, or ran out of the scope
 * `validateStepOutputRefs` allows) resolves to `undefined`, the same way a
 * producer whose declared field is absent would.
 */
function resolveStepOutputRefs(value: unknown, resultsById: ReadonlyMap<string, unknown>): unknown {
  if (isStepOutputRef(value)) return resolvePath(resultsById.get(value.step), value.path);
  if (Array.isArray(value)) return value.map((v) => resolveStepOutputRefs(v, resultsById));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveStepOutputRefs(v, resultsById)]));
  }
  return value;
}

/**
 * Find the first `policyGate` step anywhere in the Op (phases + `onFailure`,
 * including steps nested inside effect steps), if any.
 *
 * chant #2003 — `--sandbox` is a GLOBAL flag (`../cli/registry.ts`), and
 * `../cli/main.ts` arms the process-wide policy latch off it for every command,
 * `chant run` included. A `policyGate` step then reaches `loadPolicyChecks`,
 * which refuses while armed with a message written for a chant maintainer —
 * shown to a user who passed a documented flag. The combination cannot be
 * honoured until the gate can build and load policies inside the boundary
 * (#1157), so both `chant run` paths pre-flight it with this and refuse before
 * any phase executes. This is the one pre-flight refusal left on the Op path —
 * a `gate` no longer is one (#2119).
 */
export function findPolicyGateStep(config: OpConfig): ActivityStep | undefined {
  const all = [...config.phases, ...(config.onFailure ?? [])];
  const isPolicyGate = (s: StepDefinition): s is ActivityStep => isActivity(s) && s.fn === "policyGate";
  for (const phase of all) {
    for (const step of phase.steps) {
      if (isPolicyGate(step)) return step;
      if (isEffect(step)) {
        const nested = step.steps.find(isPolicyGate);
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

/**
 * Run one activity step with retry + timeout. Never throws — returns a
 * record. Any {@link StepOutputRef} in `step.args` is resolved against
 * `resultsById` before the activity is called (#1290) — an unresolved
 * placeholder must never reach an activity function, on this runtime or any
 * other; see `resolveStepOutputRefs`.
 */
async function runStep(
  step: ActivityStep,
  phaseName: string,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  resultsById: Map<string, unknown>,
  signal?: AbortSignal,
): Promise<RanStep> {
  const args = resolveStepOutputRefs(step.args ?? {}, resultsById) as Record<string, unknown>;
  const base = { phase: phaseName, fn: step.fn, args };
  const start = Date.now();

  let fn: ActivityFn;
  try {
    fn = resolveActivity(activities, step.fn);
  } catch (err) {
    return { record: { ...base, status: "fail", durationMs: 0, error: errMessage(err) } };
  }

  const profile = profiles[step.profile ?? DEFAULT_PROFILE] ?? {};
  const timeoutMs = profile.timeout
    ? parseDuration(profile.timeout)
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
      if (step.id) resultsById.set(step.id, result);
      const record: StepRecord = { ...base, status: "ok", durationMs: Date.now() - start };
      const attrs = outcomeAttributesOf(step);
      if (attrs.length > 0) {
        record.outcomes = attrs.map((a) => ({ name: a.name, value: resolvePath(result, a.from) }));
        record.outcome = record.outcomes[0];
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

// ── Gate steps (#2119) ───────────────────────────────────────────────────────

/** What a run needs to decide a gate against the ledger — see `./gate.ts`. */
interface GateContext {
  op: string;
  port: GateLedgerPort;
  now?: string;
  runId?: string;
  /** Called once per settled step, in production order (#2121) — what `--progress-json` streams from. */
  onRecord?: (record: StepRecord) => void;
}

/** Collect records and hand each to the caller's progress sink in one move. */
function pushRecord(sink: StepRecord[], ctx: GateContext, ...recs: StepRecord[]): void {
  sink.push(...recs);
  for (const r of recs) ctx.onRecord?.(r);
}

/** The record name a gate step lands under, so a reader (and a JSON consumer) can pick it out of `records`. */
function gateFn(step: GateStep): string {
  return `gate:${gateName(step)}`;
}

/**
 * Decide one gate against the ledger. A resolution newer than the gate's
 * newest pending fact passes it, and the approver lands on the step record; a
 * pending fact is recorded (or left standing) otherwise, and the caller stops
 * the run.
 */
async function runGateStep(
  step: GateStep,
  phaseName: string,
  gates: GateContext,
): Promise<{ record: StepRecord; pending?: PendingGateRecord; pushed?: boolean; pushWarning?: string }> {
  const start = Date.now();
  let check: GateCheck;
  try {
    check = await evaluateGate(gates.port, {
      op: gates.op,
      gate: gateName(step),
      ...(step.description ? { description: step.description } : {}),
      ...(step.timeout ? { timeout: step.timeout } : {}),
      ...(gates.runId ? { runId: gates.runId } : {}),
      ...(gates.now ? { now: gates.now } : {}),
    });
  } catch (err) {
    // Deciding a gate reads and writes the `chant/lifecycle` branch, so it
    // fails for all the ordinary git reasons — no committer identity, an
    // unfetched ledger, a rejected ref update. `runStep` has always turned an
    // activity's throw into a failing `StepRecord` carrying the message
    // ("Never throws — returns a record"); `runGateStep` did not, which made
    // the gate the one step kind whose failure produced no record and so no
    // rendered output at all (#2301). It does now, and the phase treats it
    // like any other failing step.
    return {
      record: {
        phase: phaseName,
        fn: gateFn(step),
        args: {},
        status: "fail",
        durationMs: Date.now() - start,
        error: errMessage(err),
      },
    };
  }

  if (check.satisfied) {
    const { resolution } = check;
    return {
      record: {
        phase: phaseName,
        fn: gateFn(step),
        args: {},
        status: "ok",
        durationMs: Date.now() - start,
        approval: {
          gate: gateName(step),
          resolvedBy: resolution.resolvedBy,
          timestamp: resolution.timestamp,
          ...(resolution.url ? { url: resolution.url } : {}),
        },
      },
    };
  }

  return {
    record: { phase: phaseName, fn: gateFn(step), args: {}, status: "skipped", durationMs: Date.now() - start },
    pending: check.pending,
    pushed: check.pushed,
    ...(check.pushWarning ? { pushWarning: check.pushWarning } : {}),
  };
}

/**
 * Run one effect step: read-compare-run-write. On a match the nested steps are
 * recorded as skipped ("effect already applied") and nothing is written. On a
 * mismatch the nested steps run in authored order; only when every one
 * succeeds is the receipt written — last, once (the sole writer, #1703
 * decision 3). Any failure leaves the receipt untouched (stale), so the next
 * run re-proposes the effect.
 *
 * A nested `gate` is decided in authored order like any other nested step
 * (#2119). Unapproved, it stops the effect before the receipt is written, so
 * the next run re-reads the receipt, re-proposes the effect, and re-evaluates
 * the gate — the receipt stays honest about what actually happened.
 */
async function runEffectStep(
  step: EffectStep,
  phaseName: string,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  resultsById: Map<string, unknown>,
  gates: GateContext,
  signal?: AbortSignal,
): Promise<{
  records: StepRecord[];
  failed: boolean;
  pending?: PendingGateRecord;
  pushed?: boolean;
  pushWarning?: string;
}> {
  const records: StepRecord[] = [];

  const read = await runStep(receiptReadStep(step), phaseName, activities, profiles, resultsById, signal);
  pushRecord(records, gates, read.record);
  if (read.record.status === "fail") return { records, failed: true };

  const result = read.result as Partial<ReceiptReadResult> | undefined;
  if (typeof result?.expectation !== "string") {
    pushRecord(records, gates, {
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
      pushRecord(records, gates, 
        nested.kind === "activity"
          ? skippedRecord(phaseName, nested.fn, nested.args)
          : skippedRecord(phaseName, gateFn(nested)),
      );
    }
    return { records, failed: false };
  }

  const skipRest = (from: number) => {
    for (const skipped of step.steps.slice(from)) {
      pushRecord(records, gates, 
        skipped.kind === "activity"
          ? skippedRecord(phaseName, skipped.fn, skipped.args)
          : skippedRecord(phaseName, gateFn(skipped)),
      );
    }
    pushRecord(records, gates, skippedRecord(phaseName, "receiptWrite"));
  };

  for (let i = 0; i < step.steps.length; i++) {
    const nested = step.steps[i];
    if (isGate(nested)) {
      const { record, pending, pushed, pushWarning } = await runGateStep(nested, phaseName, gates);
      pushRecord(records, gates, record);
      if (record.status === "fail") {
        // Receipt left untouched, as for any other failing nested step
        // (#2301) — the effect is not applied and the next run re-proposes it.
        skipRest(i + 1);
        return { records, failed: true };
      }
      if (pending) {
        // Receipt left untouched — the next run re-proposes the effect and
        // re-evaluates the gate against whatever the ledger says by then.
        skipRest(i + 1);
        return { records, failed: false, pending, pushed, ...(pushWarning ? { pushWarning } : {}) };
      }
      continue;
    }
    const ran = await runStep(nested, phaseName, activities, profiles, resultsById, signal);
    pushRecord(records, gates, ran.record);
    if (ran.record.status === "fail") {
      // Receipt left untouched (stale) — the next run re-proposes the effect.
      skipRest(i + 1);
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
    resultsById,
    signal,
  );
  pushRecord(records, gates, wrote.record);
  return { records, failed: wrote.record.status === "fail" };
}

/**
 * Run a phase. Throws `PhaseFailure` (with the records so far) if any step
 * fails, or `GateStop` if a `gate` step in it is still pending approval.
 */
async function runPhase(
  phase: PhaseDefinition,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  resultsById: Map<string, unknown>,
  gates: GateContext,
  signal?: AbortSignal,
): Promise<StepRecord[]> {
  if (phase.parallel) {
    const eff = phase.steps.find(isEffect);
    if (eff) {
      throw new Error(
        `effect step "${eff.receipt.name}" cannot run in a parallel phase — read-compare-run-write is ordered`,
      );
    }
    // Gates in a parallel phase are decided before the fan-out: a gate is a
    // read of the ledger, not work, and starting activities that a pending
    // gate is about to strand would defeat the point of stopping at it.
    const gateRecords: StepRecord[] = [];
    for (const step of phase.steps.filter(isGate)) {
      const { record, pending, pushed, pushWarning } = await runGateStep(step, phase.name, gates);
      pushRecord(gateRecords, gates, record);
      if (record.status === "fail") {
        // The gate could not be decided at all (#2301). Same treatment as a
        // pending one: nothing fans out, the activities are recorded skipped.
        for (const skipped of phase.steps.filter(isActivity)) {
          pushRecord(gateRecords, gates, skippedRecord(phase.name, skipped.fn, skipped.args));
        }
        throw new PhaseFailure(gateRecords);
      }
      if (pending) {
        for (const skipped of phase.steps.filter(isActivity)) {
          pushRecord(gateRecords, gates, skippedRecord(phase.name, skipped.fn, skipped.args));
        }
        throw new GateStop(gateRecords, pending, phase.name, pushed, pushWarning);
      }
    }
    const steps = phase.steps.filter(isActivity);
    const ran = (
      await Promise.all(steps.map((s) => runStep(s, phase.name, activities, profiles, resultsById, signal)))
    ).map((r) => r.record);
    for (const r of ran) gates.onRecord?.(r);
    const records = gateRecords.concat(ran);
    if (records.some((r) => r.status === "fail")) throw new PhaseFailure(records);
    return records;
  }

  const steps = phase.steps;
  const records: StepRecord[] = [];

  const skipRemaining = (from: number) => {
    for (const skipped of steps.slice(from)) {
      if (isEffect(skipped)) {
        pushRecord(records, gates, skippedRecord(phase.name, `effect:${skipped.receipt.name}`));
      } else if (isGate(skipped)) {
        pushRecord(records, gates, skippedRecord(phase.name, gateFn(skipped)));
      } else {
        pushRecord(records, gates, skippedRecord(phase.name, skipped.fn, skipped.args));
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (isGate(step)) {
      const { record, pending, pushed, pushWarning } = await runGateStep(step, phase.name, gates);
      pushRecord(records, gates, record);
      if (record.status === "fail") {
        // A gate that could not be decided is a failed step, not a pending
        // one (#2301) — the run failed, and the record says why.
        skipRemaining(i + 1);
        throw new PhaseFailure(records);
      }
      if (pending) {
        skipRemaining(i + 1);
        throw new GateStop(records, pending, phase.name, pushed, pushWarning);
      }
      continue;
    }
    if (isEffect(step)) {
      const { records: effRecords, failed, pending, pushed, pushWarning } = await runEffectStep(
        step, phase.name, activities, profiles, resultsById, gates, signal,
      );
      records.push(...effRecords); // already emitted by runEffectStep
      if (pending) {
        skipRemaining(i + 1);
        throw new GateStop(records, pending, phase.name, pushed, pushWarning);
      }
      if (failed) {
        skipRemaining(i + 1);
        throw new PhaseFailure(records);
      }
      continue;
    }
    const { record } = await runStep(step, phase.name, activities, profiles, resultsById, signal);
    pushRecord(records, gates, record);
    if (record.status === "fail") {
      // Mark the remaining steps in this phase as skipped, then abort.
      skipRemaining(i + 1);
      throw new PhaseFailure(records);
    }
  }
  return records;
}

// ── Public API ────────────────────────────────────────────────────────────��─

/** How a run reaches the gate ledger, and what it calls itself there (#2119). */
export interface RunOpOptions {
  /**
   * Where gate facts are read and written. Defaults to the `chant/lifecycle`
   * orphan branch under `cwd`; a test (or a caller that already holds the
   * ledger) passes `memoryGateLedgerPort()` from `./gate.ts` instead.
   */
  gates?: GateLedgerPort;
  /** Working directory for the default git-backed gate ledger. */
  cwd?: string;
  /** ISO-8601 "now", so a gate decision is deterministic under test. */
  now?: string;
  /** Identifies this run on any pending fact it records. */
  runId?: string;
  /**
   * Called once per settled step, in the order the records are produced
   * (#2121) — what the local op runtime (./runtimes/local.ts) feeds
   * `--progress-json` from. Side-effect free when omitted.
   */
  onRecord?: (record: StepRecord) => void;
  /**
   * Append the run's {@link OpRunRecord} to the run ledger
   * (`../lifecycle/run-ledger.ts`) when the run settles (#2118). Opt-in on
   * purpose: the executor is called from unit tests and in-process harnesses
   * whose working directory is an ordinary checkout, and a run there must not
   * write to the lifecycle branch. The local runtime (./runtimes/local.ts) and
   * `chant operator` pass it; nothing else does.
   */
  ledger?: { cwd?: string };
  /**
   * Called when the ledger append itself fails. The run's own outcome is
   * already decided by then, so a ledger failure is reported to the caller,
   * never promoted into a run failure.
   */
  onLedgerError?: (err: unknown) => void;
}

/**
 * Execute an Op locally.
 *
 * Resolves with the run result when every phase succeeds (`status: "ok"`), and
 * also when the run stopped at an unapproved gate (`status: "gated"`, with the
 * pending fact on `result.gate`) — a gate is a fact, not an error, so it is not
 * thrown. Rejects with `OpRunFailure` (carrying the partial result) on terminal
 * failure, after running any `onFailure` phases in reverse order; a gated run
 * runs no `onFailure` phase, because nothing failed and nothing was left
 * half-applied to compensate for.
 *
 * Whichever of the three ways it settles, the run carries an
 * {@link OpRunRecord} on `result.record` (#2118). With `options.ledger` that
 * record is also appended to `<env>/runs__<op>.jsonl` on the lifecycle branch
 * before this returns or rejects, so an Op's outcome outlives the process that
 * produced it.
 */
export async function runOpLocally(
  config: OpConfig,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal?: AbortSignal,
  options: RunOpOptions = {},
): Promise<OpRunResult> {
  // The run id is the gate ledger's and the run ledger's alike: a pending gate
  // fact and the record naming that gate carry the same string.
  const runId = options.runId ?? randomUUID();

  const gates: GateContext = {
    op: config.name,
    port: options.gates ?? gitGateLedgerPort(options.cwd ? { cwd: options.cwd } : undefined),
    ...(options.now ? { now: options.now } : {}),
    runId,
    ...(options.onRecord ? { onRecord: options.onRecord } : {}),
  };

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
  const startedAt = options.now ?? new Date(start).toISOString();

  /**
   * Build the run's ledger record, append it when asked, and hand it back for
   * the result. Called once, at whichever of the three exits the run takes.
   */
  const settle = async (
    settled: StepRecord[],
    status: OpRunResult["status"],
    gate?: PendingGateRecord,
  ): Promise<OpRunRecord> => {
    const input = buildRunRecord(config, settled, {
      started: startedAt,
      ended: options.now ?? new Date().toISOString(),
      status,
      id: runId,
      ...(gate ? { gate: { name: gate.gate, since: gate.timestamp } } : {}),
    });
    const record: OpRunRecord = { version: 1, ...input, id: runId };
    if (!options.ledger) return record;
    try {
      return (await appendRunRecord(input, options.ledger)).record;
    } catch (err) {
      options.onLedgerError?.(err);
      return record;
    }
  };

  // Completed step id → its activity result (#1290). Populated as main-phase
  // steps finish, so a later step's step-output references resolve to real
  // values before reaching an activity function — see `runStep`.
  const resultsById = new Map<string, unknown>();

  try {
    for (const phase of config.phases) {
      if (signal?.aborted) throw new PhaseFailure([]);
      records.push(...(await runPhase(phase, activities, profiles, resultsById, gates, signal)));
    }
  } catch (err) {
    // A pending gate ends the run where it stands: no later phase, and no
    // `onFailure` compensation — nothing failed, so there is nothing to undo.
    if (err instanceof GateStop) {
      records.push(...err.records);
      const stoppedAt = config.phases.findIndex((p) => p.name === err.phase);
      for (const phase of config.phases.slice(stoppedAt + 1)) {
        for (const step of phase.steps) {
          records.push(
            isEffect(step)
              ? skippedRecord(phase.name, `effect:${step.receipt.name}`)
              : isGate(step)
                ? skippedRecord(phase.name, gateFn(step))
                : skippedRecord(phase.name, step.fn, step.args),
          );
        }
      }
      return {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "gated",
        startedAt,
        gate: err.pending,
        ...(err.pushed !== undefined ? { gatePushed: err.pushed } : {}),
        ...(err.pushWarning ? { gatePushWarning: err.pushWarning } : {}),
        record: await settle(records, "gated", err.pending),
      };
    }

    if (err instanceof PhaseFailure) {
      records.push(...err.records);
    } else {
      // Everything else the phase loop can throw (#2301). `PhaseFailure` and
      // `GateStop` are the two shapes that carry their own records; anything
      // else — a git failure inside a ledger write, a bad phase definition, a
      // bug — used to be dropped here without being read, leaving a result
      // whose `records` hold nothing marked failed and nothing carrying a
      // message. The renderer prints text only from records, so the operator
      // got `Op "x" failed after 43.8s` and no cause at all.
      //
      // A synthetic record is what makes it visible: it renders as a failing
      // step like any other, lands in the run ledger, and appears in
      // `--json`. `cause` on the thrown `OpRunFailure` carries the original
      // error for a caller that wants the object rather than the text.
      records.push({
        phase: UNATTRIBUTED_PHASE,
        fn: "opFailure",
        args: {},
        status: "fail",
        durationMs: 0,
        error: errMessage(err),
      });
    }

    // Compensation: run onFailure phases in reverse order (best-effort). Skipped
    // on abort (Ctrl-C) — the user asked to stop, so don't start new work.
    if (!signal?.aborted) {
      for (const phase of [...(config.onFailure ?? [])].reverse()) {
        try {
          records.push(...(await runPhase(phase, activities, profiles, resultsById, gates, signal)));
        } catch (compErr) {
          if (compErr instanceof PhaseFailure || compErr instanceof GateStop) {
            records.push(...compErr.records);
          } else {
            // The same swallow, one level down (#2301): a compensation phase
            // that threw something else left no trace whatsoever.
            records.push({
              phase: phase.name,
              fn: "onFailure",
              args: {},
              status: "fail",
              durationMs: 0,
              error: errMessage(compErr),
            });
          }
        }
      }
    }

    throw new OpRunFailure(
      {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "fail",
        startedAt,
        record: await settle(records, "fail"),
      },
      { cause: err },
    );
  }

  return {
    op: config.name,
    records,
    totalMs: Date.now() - start,
    status: "ok",
    startedAt,
    record: await settle(records, "ok"),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
