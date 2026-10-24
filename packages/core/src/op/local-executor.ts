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
 * A gate with `resume: true` (#3947) also stores a checkpoint of the step
 * outputs the steps after it read, and the next run after the approval starts
 * at the gate instead of the first phase. It re-runs the step that produced
 * the gate's plan first, and starts at the first phase after all when the
 * plan moved. See `./gate-checkpoint.ts`.
 *
 * The executor is deliberately decoupled from any lexicon: activity
 * implementations and profiles are passed in (loaded dynamically by the CLI),
 * so core never statically depends on one.
 */

import { outcomeAttributesOf } from "./types";
import type { OpConfig, PhaseDefinition, ActivityStep, GateStep, EffectStep, StepDefinition } from "./types";
import { resolveActivity, type ActivityFn, type ActivityProfile } from "./activity-registry";
import type { ReceiptReadResult } from "./receipt-store";
import { collectStepOutputRefs, isStepOutputRef } from "./step-output-ref";
import { canonicalJson } from "../effect-receipt";
import { contentDigest } from "../content-digest";
import { parseDuration } from "./duration";
import { stepLabel, withRunConsole, withStepConsole } from "./step-console";
import { stepTimeoutProblem } from "./activity-profiles";
import { describeGateMismatch, evaluateGate, gateIsSealed, gitGateLedgerPort, type GateApprovalRule, type GateCheck, type GateLedgerPort } from "./gate";
import { gateName } from "./gate-name";
import { resolveGateAliases } from "./gate-alias";
import { gatePointOf } from "./gate-point";
import { evaluatePointGate, workspaceGatePointAsker, type GatePointAsker } from "./gate-point-run";
import type { ResolvedGateApproval } from "./gate-approval";
import { quorumRules, quorumRulesFor, type GateQuorumSpec } from "./gate-quorum";
import { GATE_PLAN_CONTEXT_KEY, gatePlanSummaryOfResult } from "./gate-plan-context";
import { withOpRunContext, type OpRunContext, type PassedGate } from "./run-context";
import type { GateAnswerRef, PendingGateRecord } from "../lifecycle/gate-ledger";
import { isPointWait, type WaitingPoint } from "./steward-points";
import { isGateWait } from "./gate-wait";
import { currentStewardTurn, enterStewardTurn } from "./steward-turn";
import { appendRunRecord, buildRunRecord } from "../lifecycle/run-ledger";
import type { OpRunRecord } from "./runtime";
import { randomUUID } from "node:crypto";
import { RunWorkLease, LEASE_LOST, workLeaseProblems, workLeaseNeedsRunItem, type WorkLeaseRunResult } from "./work-lease-run";
import { WORK_LEASE_STEP_ID } from "./types";
import { LiveRun, currentLiveRun, withLiveRun } from "./run-live";
import { runEnvOf } from "../lifecycle/run-ledger";
import { resolveCommitSha } from "../lifecycle/commit-sha";
import { resolveCiRun, type RunOrigin } from "../lifecycle/release-ledger";
import { redactDeep, redactText, type Redact } from "./redact";
import { runEventsOfStepRecord, type RunEventKind, type RunEventRuntime, type RunEventSkipReason } from "../run-event";
import { openRunEventStore, teeLines } from "../run-event-store";
import { openRunEventStream, runEventRunOf, type RunEventSink, type RunEventStream } from "../run-event-stream";
import { describePlanDigest, samePlanDigest } from "../lifecycle/plan-digest";
import type { GateCheckpoint } from "../lifecycle/gate-checkpoint";
import type { ActivityContract } from "./activity-contract";
import { buildGateCheckpoint, decideGateResume, resumeGatesOf, type GateResumeDecision, type ResumeGate } from "./gate-checkpoint";

export { parseDuration } from "./duration";

// ── Records ─────────────────────────────────────────────────────────────────

/**
 * One settled step of an Op run, as `OpRunResult.records` holds it.
 *
 * As a `chant run <op> --progress-json` line it is deprecated: read
 * `RunEvent` (`../run-event.ts`, exported from `@intentius/chant`)
 * instead, whose `step-settle` carries the run id, commit and runtime too,
 * and whose step statuses are `ok`, `failed`, `skipped`, `cached`, `gated`
 * and `waiting` (#4019). `runEventsOfStepRecord` maps a record onto it.
 * `--progress-json` keeps printing records until #4041 moves it.
 */
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
  approval?: {
    gate: string;
    resolvedBy: string;
    timestamp: string;
    url?: string;
    /**
     * On a gate with an `approval` block (#2508): whether a quorum or a policy permit passed it. `"point"` on a gate that asks a decision point (#3170).
     * `"alias"` (#3949) when an approval recorded under one of the gate's aliases counted, on any gate.
     */
    via?: "quorum" | "policy" | "point" | "alias" | "empty";
    /** On a gate with a quorum (#2508): every approver who counted toward it. */
    approvers?: string[];
    /** On a gate that asks a decision point (#3170): the answer record that passed it, which the gate ledger's resolution cites too. */
    answer?: GateAnswerRef;
    /** With `via: "alias"` (#3949): the approvals carried from an alias, each by the op, gate and time it was recorded under. */
    carriedFrom?: Array<{ op: string; gate: string; resolvedBy: string; timestamp: string }>;
  };
  /**
   * Why a step declined to proceed on something that is not a failure
   * (#2300): a gate holding a standing approval for a *different* plan. Names
   * both digests and the `chant approve` line that closes the gap. The step's
   * status is `skipped` and the run's is `gated` — nothing broke, and nothing
   * was applied.
   */
  refusal?: string;
  /**
   * Set on an activity step that asked a decision point still open (#2749):
   * the question the run now waits on. The step's status is `skipped` and the
   * run's is `waiting`: nothing broke, and a person answers the question.
   */
  point?: WaitingPoint;
  /**
   * Set on an activity step whose command stopped at a gate of its own
   * (#2779): the op the gate is recorded under and its name, what `chant
   * approve` takes. The step's status is `skipped` and the run's is `gated`.
   */
  gate?: { op: string; gate: string };
  /**
   * Set on a step this run did not execute because it resumed at a gate
   * (#3947): the run whose checkpoint supplied the step's output, and the
   * gate. The step's status is `skipped`.
   */
  resumed?: { run: string; gate: string };
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
  status: "ok" | "fail" | "gated" | "waiting";
  /** ISO-8601 start of this run. */
  startedAt: string;
  /** Present when `status === "gated"`: the pending fact the run ended on. */
  gate?: PendingGateRecord;
  /**
   * Present when `status === "waiting"` (#2749): the open decision point the
   * run stopped on. Like a gate, it is a fact and not a wait: a person answers
   * the question, and the next run reads the answer.
   */
  point?: WaitingPoint;
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
  /**
   * How the run's work lease went, for an Op that declares `workLease`
   * (#2748): the item it claimed, or why it claimed none, whether the lease
   * was released and with which outcome, or why it was lost.
   */
  workLease?: WorkLeaseRunResult;
  /**
   * Set when this run resumed at an approved gate (#3947): the gate, the run
   * whose checkpoint it carried on from, and that checkpoint's digest.
   */
  resumed?: { gate: string; run: string; checkpoint: string };
  /**
   * Why a gate that resumes did not (#3947), one line each: an approved gate
   * whose checkpoint failed a check, so the run started at the first phase,
   * or a gate this run stopped at that stored no checkpoint. Absent when
   * there is nothing to say.
   */
  resumeNotes?: string[];
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

/** Internal: a step asked a decision point that is still open (#2749). Not a failure — no compensation follows it. */
class PointStop extends Error {
  constructor(
    public readonly records: StepRecord[],
    public readonly question: WaitingPoint,
    public readonly phase: string,
  ) {
    super(`waiting on decision point ${question.id}`);
    this.name = "PointStop";
  }
}

/**
 * Internal: a step boundary found the run can't go on under its work lease
 * (#2748). `lost` false is a claim that found nothing to claim: not a
 * failure, the run ends `ok` with the rest skipped. `lost` true is a lease
 * that was lost: the run fails with `lease-lost`.
 */
class WorkStop extends Error {
  constructor(
    public readonly records: StepRecord[],
    public readonly phase: string,
    public readonly lost: boolean,
  ) {
    super(lost ? LEASE_LOST : "nothing to claim");
    this.name = "WorkStop";
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

/** The activity steps a step runs: itself, or an effect's nested ones. */
function activitiesOf(step: ActivityStep | EffectStep): ActivityStep[] {
  return isEffect(step) ? step.steps.filter(isActivity) : [step];
}

/**
 * The first step a compensation step references that has not completed in
 * this run (#3948 decision A6), or `undefined` when every one did. A failure
 * can stop the run before the step that a rollback reads, and calling the
 * rollback with `undefined` in place of that value would undo the wrong
 * thing, or nothing, while reporting `ok`.
 */
function unfinishedSource(step: ActivityStep | EffectStep, resultsById: ReadonlyMap<string, unknown>): string | undefined {
  for (const activity of activitiesOf(step)) {
    const missing = collectStepOutputRefs(activity.args).find((ref) => !resultsById.has(ref.step));
    if (missing) return missing.step;
  }
  return undefined;
}

/** The skipped record of a compensation step whose source did not complete. */
function unfinishedSourceRecord(step: ActivityStep | EffectStep, phaseName: string, source: string): StepRecord {
  const record = isEffect(step) ? skippedRecord(phaseName, `effect:${step.receipt.name}`) : skippedRecord(phaseName, step.fn, step.args);
  return { ...record, refusal: `step "${source}" did not complete in this run, so this compensation step, which reads its output, was skipped` };
}

/**
 * The digest of the step outputs an effect's nested steps read (#3948), or
 * `undefined` when they read none. The receipt store folds it into the
 * expectation, so a changed value re-fires the effect instead of the receipt
 * matching on the declared inputs alone. An existence receipt says only that
 * the effect ran once, so it takes none.
 */
function effectOutputsDigest(step: EffectStep, resultsById: ReadonlyMap<string, unknown>): string | undefined {
  if (step.receipt.flavor === "existence") return undefined;
  const read = activitiesOf(step).flatMap((a) =>
    collectStepOutputRefs(a.args).map((ref) => ({ step: ref.step, path: ref.path ?? "", value: resolveStepOutputRefs(ref, resultsById) })),
  );
  if (read.length === 0) return undefined;
  return contentDigest(canonicalJson(read));
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
  /** The pending fact a step's command stopped at (#2779), when it threw {@link GateWait}. */
  pending?: PendingGateRecord;
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
  // A step's own timeout (#2787) replaces the profile's and keeps its retries.
  if (step.timeout !== undefined) {
    const problem = stepTimeoutProblem(step.timeout);
    if (problem) return { record: { ...base, status: "fail", durationMs: 0, error: problem } };
  }
  const timeoutMs = step.timeout !== undefined
    ? parseDuration(step.timeout)
    : profile.timeout
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

  // The in-flight record names the step while it runs.
  const ended = currentLiveRun()?.stepStarted(step.fn, step.id);
  try {
    // #3956: its output printed as it arrives, and a line while it is quiet.
    return await withStepConsole({ phase: phaseName, label: stepLabel(step.fn, args, step.id) }, attempts);
  } finally {
    ended?.();
  }

  async function attempts(): Promise<RanStep> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callWithTimeout(fn, args, timeoutMs, signal);
      if (step.id) resultsById.set(step.id, result);
      const record: StepRecord = { ...base, status: "ok", durationMs: Date.now() - start };
      const attrs = outcomeAttributesOf(step);
      // An attribute whose path the result does not hold is left off, rather than recorded as undefined.
      const outcomes = attrs.map((a) => ({ name: a.name, value: resolvePath(result, a.from) })).filter((o) => o.value !== undefined);
      if (outcomes.length > 0) {
        record.outcomes = outcomes;
        record.outcome = outcomes[0];
      }
      return { record, result };
    } catch (err) {
      // An open decision point (#2749) is not a failure and not worth a retry:
      // the answer comes from a person, on a later run.
      if (isPointWait(err)) {
        return { record: { ...base, status: "skipped", durationMs: Date.now() - start, point: err.question } };
      }
      // Nor is a command that stopped at a gate of its own (#2779): the run
      // ends `gated` there, and the next run asks the command again.
      if (isGateWait(err)) {
        const gate = { op: err.pending.op, gate: err.pending.gate };
        return { record: { ...base, status: "skipped", durationMs: Date.now() - start, gate }, pending: err.pending };
      }
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
}

// ── Effect steps (#1834) ──────────────────────────────────────────────────────

/** The step data the executor synthesizes to read a receipt through the store
 * activities (`receiptRead`/`receiptWrite` — provided by the receipt row's
 * lexicon, #1835, or a mock store in tests via `receiptActivities`). */
function receiptReadStep(step: EffectStep, outputs?: string): ActivityStep {
  return {
    kind: "activity",
    fn: "receiptRead",
    args: {
      receipt: step.receipt,
      ...(step.expectation !== undefined ? { expectation: step.expectation } : {}),
      ...(outputs !== undefined ? { outputs } : {}),
    },
    profile: "fastIdempotent",
    outcomeAttribute: { name: "EffectApplied", from: "applied" },
  };
}

/**
 * What the run-event stream (#4041) says about a record that the record
 * itself does not: the step's place in its phase, why a bare skipped record
 * skipped, and the gate a gate step stopped at. Kept beside the record
 * rather than on it, so `--json`, the run ledger and `--progress-json` print
 * what they printed before.
 */
interface RecordHint {
  index?: number;
  skip?: RunEventSkipReason;
  gate?: { op: string; gate: string };
}
const recordHints = new WeakMap<StepRecord, RecordHint>();

/** Note `hint` against `record` for its run events, and hand the record back. */
function hinted(record: StepRecord, hint: RecordHint): StepRecord {
  recordHints.set(record, { ...recordHints.get(record), ...hint });
  return record;
}

/** A skipped-record for a step that will not run: one an earlier failure or stop left, unless `skip` says otherwise. */
function skippedRecord(phaseName: string, fn: string, args?: Record<string, unknown>, skip: RunEventSkipReason = "not-run"): StepRecord {
  return hinted({ phase: phaseName, fn, args: args ?? {}, status: "skipped", durationMs: 0 }, { skip });
}

// ── Gate steps (#2119) ───────────────────────────────────────────────────────

/** What a run needs to decide a gate against the ledger — see `./gate.ts`. */
interface GateContext {
  op: string;
  port: GateLedgerPort;
  now?: string;
  runId?: string;
  /** The commit the run is at (#4020), recorded on the gate facts it writes and on the run record. */
  gitSha?: string;
  /** Called once per settled step, in production order (#2121) — what `--progress-json` streams from. */
  onRecord?: (record: StepRecord) => void;
  /** Where the run's events go (#4041): a step's start, its settle and its gate's decision. */
  emit?: RunEventSink;
  /** The run context's list of passed gates (#2522). A gate that passes is appended here. */
  passed?: PassedGate[];
  /** The run's hold on its work item's lease (#2748). Absent in compensation phases, which run whatever the lease did. */
  work?: RunWorkLease;
  /** Set in `onFailure` phases (#3948): a step whose referenced step did not complete is skipped. */
  compensating?: boolean;
  /** How a gate that names a decision point asks it (#3170). */
  points?: GatePointAsker;
  /** The environment the run was started for, a point gate's `gate.env` input. */
  env?: string;
  /** The Op's gates that resume (#3947), and what a checkpoint at one needs. Absent when it has none. */
  resume?: {
    config: OpConfig;
    gates: Map<GateStep, ResumeGate>;
    commit: string | undefined;
    contracts?: ReadonlyMap<string, ActivityContract>;
    note: (line: string) => void;
  };
}

/**
 * The work lease at a step boundary (#2748): claim it when it is due, and
 * say whether the run can go on. The claim's record is pushed onto `sink`.
 * Returns `undefined` to go on, `"unclaimed"` when nothing could be claimed,
 * and `"lost"` when the lease was lost.
 */
async function workBoundary(
  phaseName: string,
  ctx: GateContext,
  resultsById: Map<string, unknown>,
  sink: StepRecord[],
): Promise<"unclaimed" | "lost" | undefined> {
  const work = ctx.work;
  if (!work) return undefined;
  if (work.due(resultsById)) {
    const start = Date.now();
    startStep(ctx, phaseName, "workLease:claim");
    let claimed: Awaited<ReturnType<RunWorkLease["claim"]>>;
    try {
      claimed = await work.claim(resultsById);
    } catch (err) {
      pushRecord(sink, ctx, {
        phase: phaseName,
        fn: "workLease:claim",
        args: {},
        status: "fail",
        durationMs: Date.now() - start,
        error: errMessage(err),
      });
      throw new PhaseFailure(sink);
    }
    if (claimed.kind === "unclaimed") {
      pushRecord(sink, ctx, {
        phase: phaseName,
        fn: "workLease:claim",
        args: { items: claimed.tried },
        status: "skipped",
        durationMs: Date.now() - start,
        refusal: claimed.refusal,
        outcome: { name: "WorkItem", value: null },
        outcomes: [{ name: "WorkItem", value: null }],
      });
      return "unclaimed";
    }
    resultsById.set(WORK_LEASE_STEP_ID, claimed.lease);
    currentLiveRun()?.item(claimed.lease.item);
    pushRecord(sink, ctx, {
      phase: phaseName,
      fn: "workLease:claim",
      args: { items: claimed.tried },
      status: "ok",
      durationMs: Date.now() - start,
      outcome: { name: "WorkItem", value: claimed.lease.item },
      outcomes: [
        { name: "WorkItem", value: claimed.lease.item },
        { name: "WorkLeaseToken", value: claimed.lease.token },
      ],
    });
  }
  return work.lost !== undefined ? "lost" : undefined;
}

/** Collect records and hand each to the caller's progress sink in one move. */
function pushRecord(sink: StepRecord[], ctx: GateContext, ...recs: StepRecord[]): void {
  sink.push(...recs);
  for (const r of recs) announce(ctx, r);
}

/** Hand a settled record to the progress sink and its run events to the event sink. */
function announce(ctx: GateContext, record: StepRecord): void {
  ctx.onRecord?.(record);
  if (!ctx.emit) return;
  const hint = recordHints.get(record);
  for (const body of runEventsOfStepRecord(record, { op: ctx.op, ...hint })) ctx.emit(body);
}

/** A step is about to run: its `step-start` event (#4041). */
function startStep(ctx: GateContext, phase: string, step: string, index?: number): void {
  ctx.emit?.({ type: "step-start", component: null, phase, step, ...(index !== undefined ? { index } : {}) });
}

/** A gate step's record, hinted with its place and, when nobody has approved it, the gate it stopped at. */
function gateRecordOf(ran: { record: StepRecord; pending?: PendingGateRecord }, index: number): StepRecord {
  return hinted(ran.record, { index, ...(ran.pending ? { gate: { op: ran.pending.op, gate: ran.pending.gate } } : {}) });
}

/** The record name a gate step lands under, so a reader (and a JSON consumer) can pick it out of `records`. */
function gateFn(step: GateStep): string {
  return `gate:${gateName(step)}`;
}

/**
 * A gate's `approval` block as this run resolves it (#2508): each context
 * value that is a step-output reference is replaced by what that step
 * returned, the same walk `plan` goes through. A reference that resolves to
 * nothing is dropped rather than failing the run, so a policy reading it sees
 * the attribute as absent.
 *
 * #4324: the quorum is `identity.gates.<gate>.quorum` in the workspace
 * declaration at base (`atBase`) whenever that sets one, and the Op's own
 * `approval.quorum` is not read then, so a change can't lower the quorum its
 * own run needs. The base quorum applies to a gate whose Op declares no
 * `approval` block too. With none at base, the Op's quorum applies as before.
 */
export function resolveGateApproval(
  step: GateStep,
  resultsById: ReadonlyMap<string, unknown>,
  env?: string,
  atBase?: GateQuorumSpec | null,
): ResolvedGateApproval | undefined {
  const baseQuorum = atBase ?? undefined;
  const authored = step.approval ?? (baseQuorum !== undefined ? {} : undefined);
  if (!authored) return undefined;
  const quorum = baseQuorum ?? authored.quorum;
  let context: Record<string, unknown> | undefined;
  if (authored.context) {
    context = {};
    for (const [key, value] of Object.entries(authored.context)) {
      const resolved = resolveStepOutputRefs(value, resultsById);
      if (resolved !== undefined && resolved !== null) context[key] = resolved;
    }
  }
  // #3182: a policy also sees what the plan does. When the gate's `plan`
  // names the step that planned it and that step returned a change set, its
  // summary lands under `context.plan` with no context code in the Op.
  if (authored.policy && isStepOutputRef(step.plan)) {
    const summary = gatePlanSummaryOfResult(resultsById.get(step.plan.step));
    if (summary) context = { ...(context ?? {}), [GATE_PLAN_CONTEXT_KEY]: summary };
  }
  // #4290: the rules this run's gate takes, by its environment. A rule with
  // `targets` never covers a run with no environment. One rule with no
  // `targets` keeps its own shape, so a standing pending fact still matches.
  const single = quorum !== undefined && !Array.isArray(quorum) && (quorum as { targets?: unknown }).targets === undefined;
  const rules = quorum ? quorumRulesFor(quorumRules(quorum), env !== undefined ? [env] : []) : [];
  return {
    ...(single ? { quorum } : rules.length > 0 ? { quorum: rules } : {}),
    ...(authored.policy ? { policy: authored.policy } : {}),
    mode: authored.mode ?? "log-only",
    ...(context ? { context } : {}),
  };
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
  resultsById: ReadonlyMap<string, unknown> = new Map(),
): Promise<{ record: StepRecord; pending?: PendingGateRecord; pushed?: boolean; pushWarning?: string }> {
  if (step.point !== undefined) return runPointGateStep(step, phaseName, gates, resultsById);
  const start = Date.now();
  // #2300: `plan` is authored as a reference into the Plan phase's result
  // (`plan.out.planDigest`), and is resolved here through the same walk an
  // activity's args go through. A reference that resolves to anything but a
  // string leaves the gate unbound — the pre-#2300 rule — rather than failing
  // a run over a missing digest.
  const resolvedPlan = resolveStepOutputRefs(step.plan, resultsById);
  const planDigest = typeof resolvedPlan === "string" && resolvedPlan !== "" ? resolvedPlan : undefined;
  // #4324: the workspace's rule for this gate at base, read once: its quorum
  // replaces the Op's, and evaluateGate judges approvals by it. A read that
  // fails ends the step as a failing record, as a ledger read does below.
  let rule: GateApprovalRule | null;
  try {
    rule = (await gates.port.approvalRule?.(gateName(step))) ?? null;
  } catch (err) {
    return { record: { phase: phaseName, fn: gateFn(step), args: {}, status: "fail", durationMs: Date.now() - start, error: errMessage(err) } };
  }
  const approval = resolveGateApproval(step, resultsById, gates.env, rule?.requirement.quorum);
  // #3947: a gate that resumes stores the outputs the steps after it read.
  const resumeAt = gates.resume?.gates.get(step);
  let checkpoint: GateCheckpoint | undefined;
  let blocked: string | undefined;
  if (resumeAt && gates.resume) {
    const built = buildGateCheckpoint(gates.resume.config, resumeAt, {
      runId: gates.runId ?? "",
      commit: gates.resume.commit,
      ...(gates.env !== undefined ? { environment: gates.env } : {}),
      ...(planDigest !== undefined ? { planDigest } : {}),
      outputs: resultsById,
      ...(gates.resume.contracts ? { contracts: gates.resume.contracts } : {}),
    });
    if ("blocked" in built) blocked = built.blocked;
    else checkpoint = built.checkpoint;
  }
  let check: GateCheck;
  try {
    check = await evaluateGate(gates.port, {
      op: gates.op,
      gate: gateName(step),
      ...(step.description ? { description: step.description } : {}),
      ...(step.timeout ? { timeout: step.timeout } : {}),
      ...(gates.runId ? { runId: gates.runId } : {}),
      ...(gates.gitSha ? { gitSha: gates.gitSha } : {}),
      ...(planDigest !== undefined ? { planDigest } : {}),
      ...(approval ? { approval } : {}),
      rule,
      ...(gates.now ? { now: gates.now } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(step.aliases?.length ? { aliases: resolveGateAliases(step, gates.op) } : {}),
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
    const passedApproval: NonNullable<StepRecord["approval"]> = {
      gate: gateName(step),
      resolvedBy: resolution.resolvedBy,
      timestamp: resolution.timestamp,
      ...(resolution.url ? { url: resolution.url } : {}),
      ...(check.via ? { via: check.via } : {}),
      ...(check.approvals ? { approvers: check.approvals.map((r) => r.resolvedBy) } : {}),
      ...(check.carried?.length
        ? { carriedFrom: check.carried.map((r) => ({ op: r.carriedFrom!.op, gate: r.carriedFrom!.gate, resolvedBy: r.resolvedBy, timestamp: r.carriedFrom!.timestamp })) }
        : {}),
    };
    // #2522: a later step reads this gate's approval from the run context
    // rather than re-tallying the ledger, so it sees the decision this run made.
    gates.passed?.push({ gate: gateName(step), approval: passedApproval });
    return {
      record: {
        phase: phaseName,
        fn: gateFn(step),
        args: {},
        status: "ok",
        durationMs: Date.now() - start,
        approval: passedApproval,
      },
    };
  }

  if (blocked) gates.resume?.note(`gate "${gateName(step)}" stored no checkpoint, so it won't resume: ${blocked}`);
  const refusal = check.mismatch
    ? { refusal: describeGateMismatch(gates.op, gateName(step), check.mismatch, await gateIsSealed(gateName(step))) }
    : {};
  return {
    record: {
      phase: phaseName,
      fn: gateFn(step),
      args: {},
      status: "skipped",
      durationMs: Date.now() - start,
      ...refusal,
    },
    pending: check.pending,
    pushed: check.pushed,
    ...(check.pushWarning ? { pushWarning: check.pushWarning } : {}),
  };
}

/**
 * Decide a gate that asks a decision point (#3170, `./gate-point-run.ts`).
 * An answer it passes on lands on the step record as the approval, citing
 * the answer record; an open question puts the question on the record, as an
 * activity's open point does, and the caller ends the run `waiting`; any
 * other answer fails the step.
 */
async function runPointGateStep(
  step: GateStep,
  phaseName: string,
  gates: GateContext,
  resultsById: ReadonlyMap<string, unknown>,
): Promise<{ record: StepRecord; pushed?: boolean; pushWarning?: string }> {
  const start = Date.now();
  const point = gatePointOf(step.point)!;
  const base = { phase: phaseName, fn: gateFn(step), args: {} };
  const resolvedPlan = resolveStepOutputRefs(step.plan, resultsById);
  const planDigest = typeof resolvedPlan === "string" && resolvedPlan !== "" ? resolvedPlan : undefined;
  const inputs = point.inputs ? (resolveStepOutputRefs(point.inputs, resultsById) as Record<string, unknown>) : undefined;
  try {
    const check = await evaluatePointGate(gates.port, gates.points ?? workspaceGatePointAsker(process.cwd()), {
      op: gates.op,
      gate: gateName(step),
      point,
      ...(inputs ? { inputs } : {}),
      ...(step.description ? { description: step.description } : {}),
      ...(step.timeout ? { timeout: step.timeout } : {}),
      ...(gates.runId ? { runId: gates.runId } : {}),
      ...(gates.gitSha ? { gitSha: gates.gitSha } : {}),
      ...(planDigest !== undefined ? { planDigest } : {}),
      ...(gates.env !== undefined ? { env: gates.env } : {}),
      ...(gates.now ? { now: gates.now } : {}),
    });
    if (check.satisfied) {
      const approval: NonNullable<StepRecord["approval"]> = {
        gate: gateName(step),
        resolvedBy: check.resolution.resolvedBy,
        timestamp: check.resolution.timestamp,
        via: "point",
        ...(check.answer.answeredBy ? { approvers: check.answer.answeredBy } : {}),
        answer: check.answer,
      };
      gates.passed?.push({ gate: gateName(step), approval });
      return { record: { ...base, status: "ok", durationMs: Date.now() - start, approval }, pushed: check.pushed, ...(check.pushWarning ? { pushWarning: check.pushWarning } : {}) };
    }
    if ("refused" in check) return { record: { ...base, status: "fail", durationMs: Date.now() - start, error: check.refused } };
    return { record: { ...base, status: "skipped", durationMs: Date.now() - start, point: check.waiting }, pushed: check.pushed, ...(check.pushWarning ? { pushWarning: check.pushWarning } : {}) };
  } catch (err) {
    return { record: { ...base, status: "fail", durationMs: Date.now() - start, error: errMessage(err) } };
  }
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
  signal: AbortSignal | undefined,
  index: number,
): Promise<{
  records: StepRecord[];
  failed: boolean;
  pending?: PendingGateRecord;
  pushed?: boolean;
  pushWarning?: string;
  point?: WaitingPoint;
}> {
  const records: StepRecord[] = [];

  let outputs: string | undefined;
  try {
    outputs = effectOutputsDigest(step, resultsById);
  } catch (err) {
    // A resolved value JSON cannot hold (canonicalJson refuses it) would be a wrong expectation.
    startStep(gates, phaseName, `effect:${step.receipt.name}`, index);
    pushRecord(records, gates, hinted({ phase: phaseName, fn: `effect:${step.receipt.name}`, args: {}, status: "fail", durationMs: 0, error: errMessage(err) }, { index }));
    return { records, failed: true };
  }
  startStep(gates, phaseName, "receiptRead", index);
  const read = await runStep(receiptReadStep(step, outputs), phaseName, activities, profiles, resultsById, signal);
  pushRecord(records, gates, hinted(read.record, { index }));
  if (read.record.status === "fail") return { records, failed: true };

  const result = read.result as Partial<ReceiptReadResult> | undefined;
  if (typeof result?.expectation !== "string") {
    startStep(gates, phaseName, `effect:${step.receipt.name}`, index);
    pushRecord(records, gates, hinted({
      phase: phaseName,
      fn: `effect:${step.receipt.name}`,
      args: {},
      status: "fail",
      durationMs: 0,
      error: "receiptRead returned no expectation — the receipt store activity must return { current, expectation }",
    }, { index }));
    return { records, failed: true };
  }
  const expectation = result.expectation;

  if (result.current === expectation) {
    // Effect already applied — skip the nested steps, write nothing.
    for (const nested of step.steps) {
      pushRecord(records, gates, 
        hinted(nested.kind === "activity"
          ? skippedRecord(phaseName, nested.fn, nested.args, "receipt")
          : skippedRecord(phaseName, gateFn(nested), undefined, "receipt"), { index }),
      );
    }
    return { records, failed: false };
  }

  const skipRest = (from: number) => {
    for (const skipped of step.steps.slice(from)) {
      pushRecord(records, gates, 
        hinted(skipped.kind === "activity"
          ? skippedRecord(phaseName, skipped.fn, skipped.args)
          : skippedRecord(phaseName, gateFn(skipped)), { index }),
      );
    }
    pushRecord(records, gates, hinted(skippedRecord(phaseName, "receiptWrite"), { index }));
  };

  for (let i = 0; i < step.steps.length; i++) {
    const nested = step.steps[i];
    if (isGate(nested)) {
      startStep(gates, phaseName, gateFn(nested), index);
      const decided = await runGateStep(nested, phaseName, gates, resultsById);
      const { record, pending, pushed, pushWarning } = decided;
      pushRecord(records, gates, gateRecordOf(decided, index));
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
      if (record.point) {
        // A gate's open decision point (#3170): as for an activity's.
        skipRest(i + 1);
        return { records, failed: false, point: record.point };
      }
      continue;
    }
    startStep(gates, phaseName, nested.fn, index);
    const ran = await runStep(nested, phaseName, activities, profiles, resultsById, signal);
    pushRecord(records, gates, hinted(ran.record, { index }));
    if (ran.pending) {
      // A command's own gate (#2779): the receipt is left untouched, as for a
      // pending gate step.
      skipRest(i + 1);
      return { records, failed: false, pending: ran.pending };
    }
    if (ran.record.point) {
      // Receipt left untouched, as for a pending gate: the next run re-proposes
      // the effect and asks the point again, and finds the answer by then.
      skipRest(i + 1);
      return { records, failed: false, point: ran.record.point };
    }
    if (ran.record.status === "fail") {
      // Receipt left untouched (stale) — the next run re-proposes the effect.
      skipRest(i + 1);
      return { records, failed: true };
    }
  }

  // Sole writer of the receipt: on success of every nested step, last.
  startStep(gates, phaseName, "receiptWrite", index);
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
  pushRecord(records, gates, hinted(wrote.record, { index }));
  return { records, failed: wrote.record.status === "fail" };
}

/**
 * Run a phase. Throws `PhaseFailure` (with the records so far) if any step
 * fails, or `GateStop` if a `gate` step in it is still pending approval.
 * `from` starts a sequential phase at that step, for a run that resumes at a
 * gate in it (#3947); the steps before it are the caller's to record.
 */
async function runPhase(
  phase: PhaseDefinition,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  resultsById: Map<string, unknown>,
  gates: GateContext,
  signal?: AbortSignal,
  from = 0,
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
    const stop = await workBoundary(phase.name, gates, resultsById, gateRecords);
    const at = (step: StepDefinition) => phase.steps.indexOf(step);
    const skipActivities = () => {
      for (const skipped of phase.steps.filter(isActivity)) {
        pushRecord(gateRecords, gates, hinted(skippedRecord(phase.name, skipped.fn, skipped.args), { index: at(skipped) }));
      }
    };
    if (stop) {
      for (const skipped of phase.steps) {
        pushRecord(gateRecords, gates, hinted(isGate(skipped) ? skippedRecord(phase.name, gateFn(skipped)) : skippedRecord(phase.name, (skipped as ActivityStep).fn, (skipped as ActivityStep).args), { index: at(skipped) }));
      }
      throw new WorkStop(gateRecords, phase.name, stop === "lost");
    }
    for (const step of phase.steps.filter(isGate)) {
      startStep(gates, phase.name, gateFn(step), at(step));
      const decided = await runGateStep(step, phase.name, gates, resultsById);
      const { record, pending, pushed, pushWarning } = decided;
      pushRecord(gateRecords, gates, gateRecordOf(decided, at(step)));
      if (record.status === "fail") {
        // The gate could not be decided at all (#2301). Same treatment as a
        // pending one: nothing fans out, the activities are recorded skipped.
        skipActivities();
        throw new PhaseFailure(gateRecords);
      }
      if (pending) {
        skipActivities();
        throw new GateStop(gateRecords, pending, phase.name, pushed, pushWarning);
      }
      if (record.point) {
        // A gate's open decision point (#3170): nothing fans out.
        skipActivities();
        throw new PointStop(gateRecords, record.point, phase.name);
      }
    }
    const steps = phase.steps.filter(isActivity);
    const settled = await Promise.all(steps.map((s) => {
      const source = gates.compensating ? unfinishedSource(s, resultsById) : undefined;
      if (source) return { record: unfinishedSourceRecord(s, phase.name, source) } as RanStep;
      startStep(gates, phase.name, s.fn, at(s));
      return runStep(s, phase.name, activities, profiles, resultsById, signal);
    }));
    const ran = settled.map((r, k) => hinted(r.record, { index: at(steps[k]!) }));
    for (const r of ran) announce(gates, r);
    const records = gateRecords.concat(ran);
    if (records.some((r) => r.status === "fail")) throw new PhaseFailure(records);
    // A step whose command stopped at its own gate (#2779) stops the run at
    // this phase, as a gate step would, once its siblings have finished.
    const gated = settled.find((r) => r.pending)?.pending;
    if (gated) throw new GateStop(records, gated, phase.name);
    // The fan-out has already run, so the siblings of an open decision point
    // finished; the run still stops at this phase (#2749).
    const waiting = ran.find((r) => r.point);
    if (waiting?.point) throw new PointStop(records, waiting.point, phase.name);
    return records;
  }

  const steps = phase.steps;
  const records: StepRecord[] = [];

  const skipRemaining = (from: number) => {
    for (const [k, skipped] of steps.slice(from).entries()) {
      const index = { index: from + k };
      if (isEffect(skipped)) {
        pushRecord(records, gates, hinted(skippedRecord(phase.name, `effect:${skipped.receipt.name}`), index));
      } else if (isGate(skipped)) {
        pushRecord(records, gates, hinted(skippedRecord(phase.name, gateFn(skipped)), index));
      } else {
        pushRecord(records, gates, hinted(skippedRecord(phase.name, skipped.fn, skipped.args), index));
      }
    }
  };

  for (let i = from; i < steps.length; i++) {
    const step = steps[i];
    // The work lease (#2748): claimed here when it is due, and checked before
    // every step, so no step starts once the lease is lost.
    const stop = await workBoundary(phase.name, gates, resultsById, records);
    if (stop) {
      skipRemaining(i);
      throw new WorkStop(records, phase.name, stop === "lost");
    }
    if (isGate(step)) {
      startStep(gates, phase.name, gateFn(step), i);
      const decided = await runGateStep(step, phase.name, gates, resultsById);
      const { record, pending, pushed, pushWarning } = decided;
      pushRecord(records, gates, gateRecordOf(decided, i));
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
      if (record.point) {
        // A gate that asks a decision point (#3170) and found it open: the
        // run waits on the question, as at an activity's open point.
        skipRemaining(i + 1);
        throw new PointStop(records, record.point, phase.name);
      }
      continue;
    }
    const source = gates.compensating ? unfinishedSource(step, resultsById) : undefined;
    if (source) {
      pushRecord(records, gates, hinted(unfinishedSourceRecord(step, phase.name, source), { index: i }));
      continue;
    }
    if (isEffect(step)) {
      const { records: effRecords, failed, pending, pushed, pushWarning, point } = await runEffectStep(
        step, phase.name, activities, profiles, resultsById, gates, signal, i,
      );
      records.push(...effRecords); // already emitted by runEffectStep
      if (point) {
        skipRemaining(i + 1);
        throw new PointStop(records, point, phase.name);
      }
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
    startStep(gates, phase.name, step.fn, i);
    const { record, pending } = await runStep(step, phase.name, activities, profiles, resultsById, signal);
    pushRecord(records, gates, hinted(record, { index: i }));
    if (pending) {
      // The step's command stopped at its own gate (#2779): the run ends
      // `gated` there, as at a pending gate step.
      skipRemaining(i + 1);
      throw new GateStop(records, pending, phase.name);
    }
    if (record.point) {
      // An open decision point (#2749) ends the run as a pending gate does.
      skipRemaining(i + 1);
      throw new PointStop(records, record.point, phase.name);
    }
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
   * How a gate that names a decision point asks it (#3170). Defaults to the
   * workspace holding `cwd` (`workspaceGatePointAsker`); a test passes a stub.
   */
  points?: GatePointAsker;
  /**
   * The environment the run was started for (`--env`, #2522). The executor
   * only hands it to activities through the run context (`./run-context.ts`).
   * The run ledger path still comes from the Op's `labels.Env`.
   */
  env?: string;
  /**
   * Called once per settled step, in the order the records are produced
   * (#2121) — what the local op runtime (./runtimes/local.ts) feeds
   * `--progress-json` from. Side-effect free when omitted.
   */
  onRecord?: (record: StepRecord) => void;
  /**
   * Where the run's event stream goes (#4041, `chant run <op> --events-json`),
   * one `run-event.schema.json` line at a time: the run's start and settle,
   * each phase's, each step's start and settle, and each gate's decision.
   * `runtime` and `runOrigin` name where the run happened when the executor
   * cannot tell: by default it is `ci` in a CI job, `steward` in a steward's
   * turn and `local` otherwise. Omitted, nothing is written.
   */
  runEvents?: { write: (line: string) => void; runtime?: RunEventRuntime; runOrigin?: RunOrigin };
  /**
   * What ran the Op, when a runner says so itself (#4094): `chant ci run`
   * runs a pull-request job as an Op and passes `kind: "pipeline"`,
   * `runtime: "ci"` and `runOrigin: { forge: "chant" }`. The run's events
   * carry all three, kept on this host as well as written to
   * {@link runEvents}, and the run record carries `runOrigin` in place of
   * the CI run the environment names. Omitted, the run is an `op` run named
   * as described on {@link runEvents}.
   */
  runner?: { kind: RunEventKind; runtime: RunEventRuntime; runOrigin: RunOrigin };
  /**
   * Says why a failed run failed (#4094), given the run's step records once
   * it has settled `fail`. What it returns is stored on the record as
   * `failure`, before the record is signed, and carried on the `run-settle`
   * event. `chant ci run` reads the job's pull-request report here, while
   * the checkout it ran in still exists.
   */
  describeFailure?: (records: readonly StepRecord[]) => OpRunRecord["failure"];
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
   * Signs the run's record when it settles (#4044): given the record without
   * a statement, returns the DSSE envelope stored on it as `statement`
   * (`../workspace/trust/op-run-statement.ts`). `chant run <op> --key` and
   * `CHANT_RUNNER_KEY` pass one made from a runner key. When it throws, the
   * record is written unsigned and `onSignError` hears why.
   */
  signRecord?: (record: OpRunRecord) => NonNullable<OpRunRecord["statement"]>;
  /** Called when {@link signRecord} throws. The run's outcome stands. */
  onSignError?: (err: unknown) => void;
  /**
   * Called when the ledger append itself fails. The run's own outcome is
   * already decided by then, so a ledger failure is reported to the caller,
   * never promoted into a run failure.
   */
  onLedgerError?: (err: unknown) => void;
  /** The steward whose turn this run is (#2749), recorded on its ledger record. */
  steward?: string;
  /**
   * For an Op that declares `workLease` (#2748): the item this run is for
   * (`chant run <op> --work <id>`), which takes the place of the Op's own, and
   * who holds the lease (a steward's turn passes `stewardWorkHolder`).
   * Defaults: the Op's item, and this process's holder id.
   */
  work?: { item?: string; holder?: string };
  /** Called when a work-lease renewal fails without losing the lease; the next beat retries it. */
  onWorkLeaseWarning?: (message: string) => void;
  /**
   * Where a running step's output goes, line by line, as it arrives (#3956):
   * `[<phase>] <step> | <line>` for each line a `shellCmd` command writes, and
   * `[<phase>] <step>: still running after <n>s` for a step quiet for
   * `stepHeartbeatMs` (./step-console.ts). The local runtime passes a writer
   * to stderr. Omitted, nothing is printed while a step runs.
   */
  stepOutput?: (line: string) => void;
  /** How long a step may be quiet before the still-running line. Default 60s; `0` turns it off. */
  stepHeartbeatMs?: number;
  /**
   * The commit the checkout is at, for an Op with a gate that resumes
   * (#3947). A checkpoint records it and a resumed run must match it.
   * Default: `git rev-parse HEAD` in `cwd`, and none when that fails, so no
   * gate resumes.
   */
  commit?: string;
  /**
   * The activity contracts the run knows (#3947). A gate that resumes stores
   * no output a contract marks secret, and doesn't resume when a later step
   * needs one. The local runtime passes the configured lexicons' contracts.
   */
  contracts?: ReadonlyMap<string, ActivityContract>;
  /**
   * Redacts secret values (#4096) from what the run writes about itself:
   * each {@link runEvents} line and each line kept on this host, each
   * {@link stepOutput} line and step label, and the run record, its step
   * records and its `failure`, before {@link signRecord} signs it and the
   * ledger stores it. The step records on the result are redacted too. This
   * is the one place a run's writes pass through, so a writer added here
   * later is redacted with the rest. `chant ci run` passes one built from
   * the host's secrets file (../workspace/ci-secrets.ts).
   */
  redact?: Redact;
}

/**
 * Execute an Op locally.
 *
 * Resolves with the run result when every phase succeeds (`status: "ok"`), and
 * also when the run stopped at an unapproved gate (`status: "gated"`, with the
 * pending fact on `result.gate`) — a gate is a fact, not an error, so it is not
 * thrown. So does an activity's open decision point (`status: "waiting"`, with
 * the question on `result.point`, #2749). Rejects with `OpRunFailure` (carrying the partial result) on terminal
 * failure, after running any `onFailure` phases in reverse order; a gated or
 * waiting run runs no `onFailure` phase, because nothing failed and nothing was left
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
  // In a steward's turn (#2749: `chant operator --steward`, or `chant acp
  // --steward` on Fountain) the run is the steward's: its record names the
  // steward, and a decision point asked during it names this run.
  const turn = currentStewardTurn();
  const steward = options.steward ?? turn?.steward;
  const restore = turn && turn.run !== runId ? enterStewardTurn({ ...turn, run: runId }) : undefined;
  // #2522: every activity in this run can read the run it is in.
  const run: OpRunContext = {
    op: config.name,
    runId,
    ...(options.env !== undefined ? { env: options.env } : {}),
    passedGates: [],
  };
  // A run that writes to the ledger also says what it is doing while it runs
  // (./run-live.ts), and removes that once its record is written.
  const live = options.ledger
    ? await LiveRun.open({
        cwd: options.ledger.cwd ?? options.cwd ?? process.cwd(),
        env: runEnvOf(config),
        op: config.name,
        id: runId,
        started: options.now ?? new Date().toISOString(),
        ...(steward ? { steward } : {}),
      })
    : undefined;
  // The run's event stream (#4041), opened once the commit is known; held
  // here so a run that throws before it settles still ends its stream.
  const events: { stream?: RunEventStream } = {};
  try {
    const stepConsole = options.stepOutput
      ? {
          write: options.stepOutput,
          ...(options.stepHeartbeatMs !== undefined ? { heartbeatMs: options.stepHeartbeatMs } : {}),
          ...(options.redact ? { redact: options.redact } : {}),
        }
      : undefined;
    return await withLiveRun(live, () =>
      withRunConsole(stepConsole, () =>
        withOpRunContext(run, () =>
          runOpInTurn(config, activities, profiles, signal, { ...options, runId, ...(steward ? { steward } : {}) }, run, events),
        ),
      ),
    );
  } catch (err) {
    events.stream?.settle("failed", errMessage(err));
    throw err;
  } finally {
    live?.close();
    restore?.();
  }
}

async function runOpInTurn(
  config: OpConfig,
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
  signal: AbortSignal | undefined,
  options: RunOpOptions & { runId: string },
  run: OpRunContext,
  events: { stream?: RunEventStream },
): Promise<OpRunResult> {
  const runId = options.runId;
  // #4020: the commit the run builds from, on its record and on the gate facts it writes.
  const commit = options.commit ?? (await resolveCommitSha(options.cwd ? { cwd: options.cwd } : {}));
  // #4020: the CI run this one is in, in the shape a deploy record carries it.
  const ciRun = resolveCiRun();
  // #4041: the run's events name it the way its run record does: its own id,
  // the commit, and the CI run it is in.
  // #4042: a run that writes to the ledger also keeps its events on this host,
  // beside its in-flight record, so `chant run events <run>` can replay it and
  // `--follow` can tail it. The stream is opened for that even without
  // `--events-json`; a run that records nothing (`--no-record`) keeps nothing.
  const store = options.ledger
    ? await openRunEventStore(options.ledger.cwd ?? options.cwd ?? process.cwd(), runId)
    : undefined;
  const teed = teeLines(options.runEvents?.write, store?.write.bind(store));
  // #4096: every event line, to the caller and to this host's store alike, is redacted once, here.
  const redact = options.redact;
  const eventsWrite = teed && redact ? (line: string) => teed(redactText(line, redact)) : teed;
  const stream = eventsWrite
    ? openRunEventStream(
        runEventRunOf({
          kind: options.runner?.kind ?? "op",
          name: config.name,
          runId,
          ...(commit ? { gitSha: commit } : {}),
          ...(ciRun ? { ci: ciRun } : {}),
          steward: options.steward !== undefined,
          ...(options.runEvents?.runtime ? { runtime: options.runEvents.runtime } : {}),
          ...(options.runEvents?.runOrigin ? { runOrigin: options.runEvents.runOrigin } : {}),
          ...(options.runner ? { runtime: options.runner.runtime, runOrigin: options.runner.runOrigin } : {}),
        }),
        eventsWrite,
      )
    : undefined;
  events.stream = stream;
  stream?.emit({ type: "run-start", waves: null });

  const gates: GateContext = {
    op: config.name,
    port: options.gates ?? gitGateLedgerPort(options.cwd ? { cwd: options.cwd } : undefined),
    ...(options.now ? { now: options.now } : {}),
    runId,
    ...(commit ? { gitSha: commit } : {}),
    ...(options.onRecord ? { onRecord: options.onRecord } : {}),
    ...(stream ? { emit: stream.emit } : {}),
    passed: run.passedGates,
    points: options.points ?? workspaceGatePointAsker(options.cwd ?? process.cwd()),
    ...(options.env !== undefined ? { env: options.env } : {}),
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

  // The work lease (#2748). An Op that changes the checkout without one, or
  // whose lease names no item and whose run names none, is refused before
  // anything runs.
  const workProblems = workLeaseProblems(config);
  if (workProblems.length > 0) throw new Error(workProblems.join("\n"));
  if (workLeaseNeedsRunItem(config) && !options.work?.item) {
    throw new Error(
      `Op "${config.name}" runs under a work item's lease and names no item: pass one with \`chant run ${config.name} --work <id>\``,
    );
  }
  const work = config.workLease
    ? new RunWorkLease(config, {
        cwd: options.ledger?.cwd ?? options.cwd ?? process.cwd(),
        ...(options.work?.holder ? { holder: options.work.holder } : {}),
        ...(options.work?.item ? { item: options.work.item } : {}),
        ...(options.onWorkLeaseWarning ? { onRenewError: options.onWorkLeaseWarning } : {}),
      })
    : undefined;
  if (work) gates.work = work;

  // Steps run under a signal that also fires when the work lease is lost, so
  // the step in flight stops (chud's dispatcher stopped its agent the same way).
  let stepSignal = signal;
  if (work) {
    const both = new AbortController();
    const forward = () => both.abort();
    if (signal?.aborted) both.abort();
    else signal?.addEventListener("abort", forward, { once: true });
    work.lostSignal.addEventListener("abort", forward, { once: true });
    stepSignal = both.signal;
  }

  /** Release (or not) the work lease once the run's outcome is settled. */
  const finishWork = async (status: OpRunResult["status"]): Promise<{ workLease?: WorkLeaseRunResult }> =>
    work ? { workLease: await work.finish(status, resultsById) } : {};

  /** The record a lost lease leaves, naming why. */
  const lostRecord = (): StepRecord => ({
    phase: UNATTRIBUTED_PHASE,
    fn: "workLease:lost",
    args: {},
    status: "fail",
    durationMs: 0,
    error: `${LEASE_LOST}: ${work?.lost ?? "the lease was lost"}. The run stopped and was not recorded as done.`,
  });

  const skipLaterPhases = (after: string) => {
    const stoppedAt = config.phases.findIndex((p) => p.name === after);
    if (stoppedAt < 0) return;
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
  };

  const records: StepRecord[] = [];
  const start = Date.now();
  // Each phase's wall-clock time, for the run record and the in-flight one.
  const phaseDurations: Record<string, number> = {};
  const timedPhase = async (phase: PhaseDefinition, ctx: GateContext, phaseSignal: AbortSignal | undefined, from = 0): Promise<StepRecord[]> => {
    const live = currentLiveRun();
    const t0 = Date.now();
    live?.phaseStarted(phase.name);
    stream?.emit({ type: "phase-start", component: null, phase: phase.name });
    try {
      const ran = await runPhase(phase, activities, profiles, resultsById, ctx, phaseSignal, from);
      live?.phaseEnded(phase.name, phaseVerdict(ran), Date.now() - t0);
      stream?.emit({ type: "phase-settle", component: null, phase: phase.name, status: "ok" });
      return ran;
    } catch (err) {
      const status = err instanceof GateStop ? "gated" : err instanceof PointStop ? "waiting" : err instanceof WorkStop && !err.lost ? "ok" : "failed";
      stream?.emit({ type: "phase-settle", component: null, phase: phase.name, status });
      throw err;
    } finally {
      phaseDurations[phase.name] = (phaseDurations[phase.name] ?? 0) + (Date.now() - t0);
    }
  };
  const startedAt = options.now ?? new Date(start).toISOString();

  /**
   * Build the run's ledger record, append it when asked, and hand it back for
   * the result. Called once, at whichever of the three exits the run takes.
   */
  const settle = async (
    settled: StepRecord[],
    status: OpRunResult["status"],
    gate?: PendingGateRecord,
    point?: WaitingPoint,
  ): Promise<OpRunRecord> => {
    const ended = options.now ?? new Date().toISOString();
    let input = buildRunRecord(config, settled, {
      started: startedAt,
      ended,
      status,
      id: runId,
      // A gate recorded under another op (#2779: a command's own gate) names it.
      ...(gate ? { gate: { name: gate.gate, since: gate.timestamp, ...(gate.op !== config.name ? { op: gate.op } : {}) } } : {}),
      ...(point ? { point: { ...point, since: ended } } : {}),
      ...(options.steward ? { steward: options.steward } : {}),
      ...(resumed ? { resumed } : {}),
      ...(commit ? { gitSha: commit } : {}),
      ...(options.runner ? { runOrigin: options.runner.runOrigin } : ciRun ? { runOrigin: ciRun.runOrigin } : {}),
      phaseDurations,
    });
    if (status === "fail" && options.describeFailure) {
      const failure = options.describeFailure(settled);
      if (failure) input.failure = failure;
    }
    // #4096: the record is redacted before it is signed, so the stored record is the one the statement covers.
    // The step records on the result are redacted in place, so a caller printing them prints no secret.
    if (redact) {
      input = redactDeep(input, redact);
      for (const r of settled) {
        if (r.error !== undefined) r.error = redact(r.error);
        if (r.args) r.args = redactDeep(r.args, redact);
      }
    }
    let record: OpRunRecord = { version: 1, ...input, id: runId };
    if (options.signRecord) {
      try {
        const statement = options.signRecord(record);
        input.statement = statement;
        record = { ...record, statement };
      } catch (err) {
        options.onSignError?.(err);
      }
    }
    // The stream settles as the run does, with the first failing step's error.
    const firstError = status === "fail" ? settled.find((r) => r.status === "fail")?.error : undefined;
    stream?.settle(status === "fail" ? "failed" : status, firstError, input.failure);
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

  // #3947: the gates that resume. Each stores a checkpoint when the run stops
  // at it, and the run may start at one of them.
  let resumed: OpRunResult["resumed"];
  const resumeNotes: string[] = [];
  const resumeGates = resumeGatesOf(config);
  if (resumeGates.length > 0) {
    gates.resume = {
      config,
      gates: new Map(resumeGates.map((g) => [g.step, g])),
      commit,
      ...(options.contracts ? { contracts: options.contracts } : {}),
      note: (line) => resumeNotes.push(line),
    };
  }
  const resumeFields = (): Pick<OpRunResult, "resumed" | "resumeNotes"> => ({
    ...(resumed ? { resumed } : {}),
    ...(resumeNotes.length > 0 ? { resumeNotes: [...resumeNotes] } : {}),
  });

  /**
   * Resume at the gate `decision` names (#3947): seed the checkpoint's
   * outputs, record every step before the gate as resumed, and run the step
   * that produced the gate's plan again. Returns where the phases pick up, or
   * undefined when the plan moved and the run starts at the first phase.
   */
  const resumeAt = async (
    decision: Extract<GateResumeDecision, { kind: "resume" }>,
  ): Promise<{ phaseIndex: number; stepIndex: number } | undefined> => {
    const { gate, checkpoint } = decision;
    for (const [id, value] of Object.entries(checkpoint.outputs)) resultsById.set(id, value);
    const marker = { run: checkpoint.runId, gate: gate.name };
    const prefix: StepRecord[] = [];
    for (const [pi, phase] of config.phases.entries()) {
      if (pi > gate.phaseIndex) break;
      const steps = pi < gate.phaseIndex ? phase.steps : phase.parallel ? [] : phase.steps.slice(0, gate.stepIndex);
      for (const [si, step] of steps.entries()) {
        if (gate.planStep && pi === gate.planStep.phaseIndex && si === gate.planStep.stepIndex) {
          startStep(gates, phase.name, gate.planStep.step.fn, si);
          const ran = await runStep(gate.planStep.step, phase.name, activities, profiles, resultsById, stepSignal);
          prefix.push(hinted(ran.record, { index: si }));
          if (ran.record.status === "fail" || ran.pending || ran.record.point) {
            for (const r of prefix) announce(gates, r);
            if (ran.pending) throw new GateStop(prefix, ran.pending, phase.name);
            if (ran.record.point) throw new PointStop(prefix, ran.record.point, phase.name);
            throw new PhaseFailure(prefix);
          }
          continue;
        }
        const skipped = isEffect(step)
          ? skippedRecord(phase.name, `effect:${step.receipt.name}`)
          : isGate(step)
            ? skippedRecord(phase.name, gateFn(step))
            : skippedRecord(phase.name, step.fn, step.args);
        prefix.push(hinted({ ...skipped, resumed: marker }, { index: si }));
      }
    }
    // The plan the run would approve now against the one approved: a moved
    // plan is live drift since the approval, and starts the run over.
    const resolved = resolveStepOutputRefs(gate.step.plan, resultsById);
    const planned = typeof resolved === "string" && resolved !== "" ? resolved : undefined;
    if (!samePlanDigest(planned, decision.pending.planDigest)) {
      resultsById.clear();
      resumeNotes.push(
        `gate "${gate.name}" is approved, and the run starts at the first phase: the plan moved since the approval ` +
          `(approved ${describePlanDigest(decision.pending.planDigest)}, planned ${planned ?? "(none)"})`,
      );
      return undefined;
    }
    records.push(...prefix);
    for (const r of prefix) announce(gates, r);
    resumed = { gate: gate.name, run: checkpoint.runId, checkpoint: decision.digest };
    return { phaseIndex: gate.phaseIndex, stepIndex: config.phases[gate.phaseIndex]!.parallel ? 0 : gate.stepIndex };
  };

  try {
    let from: { phaseIndex: number; stepIndex: number } | undefined;
    if (gates.resume) {
      const decision = await decideGateResume(gates.port, config, {
        now: options.now ?? new Date().toISOString(),
        commit: gates.resume.commit,
        ...(options.env !== undefined ? { environment: options.env } : {}),
      });
      if (decision.kind === "refused") {
        resumeNotes.push(`gate "${decision.gate}" is approved, and the run starts at the first phase: ${decision.reason}`);
      } else if (decision.kind === "resume") {
        from = await resumeAt(decision);
      }
    }
    for (let pi = from?.phaseIndex ?? 0; pi < config.phases.length; pi++) {
      if (signal?.aborted) throw new PhaseFailure([]);
      records.push(...(await timedPhase(config.phases[pi]!, gates, stepSignal, pi === from?.phaseIndex ? from.stepIndex : 0)));
    }
    // The last renewal before the run is recorded (#2748): a run whose lease
    // was lost is never recorded as done.
    if (work && !(await work.fence())) throw new WorkStop([], UNATTRIBUTED_PHASE, true);
  } catch (err) {
    // Nothing to claim, or every candidate held (#2748): not a failure. The
    // rest of the run is skipped and the claim's record says why.
    if (err instanceof WorkStop && !err.lost) {
      records.push(...err.records);
      skipLaterPhases(err.phase);
      const record = await settle(records, "ok");
      return {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "ok",
        startedAt,
        record,
        ...(await finishWork("ok")),
        ...resumeFields(),
      };
    }

    // An open decision point ends the run the way a pending gate does (#2749):
    // no later phase and no compensation, and the run is `waiting`.
    if (err instanceof PointStop) {
      records.push(...err.records);
      skipLaterPhases(err.phase);
      const record = await settle(records, "waiting", undefined, err.question);
      return {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "waiting",
        startedAt,
        point: err.question,
        record,
        ...(await finishWork("waiting")),
        ...resumeFields(),
      };
    }

    // A pending gate ends the run where it stands: no later phase, and no
    // `onFailure` compensation — nothing failed, so there is nothing to undo.
    if (err instanceof GateStop) {
      records.push(...err.records);
      skipLaterPhases(err.phase);
      const record = await settle(records, "gated", err.pending);
      return {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "gated",
        startedAt,
        gate: err.pending,
        ...(err.pushed !== undefined ? { gatePushed: err.pushed } : {}),
        ...(err.pushWarning ? { gatePushWarning: err.pushWarning } : {}),
        record,
        ...(await finishWork("gated")),
        ...resumeFields(),
      };
    }

    if (err instanceof WorkStop) {
      // The lease was lost (#2748): the rest is skipped, and the lost record
      // below says why.
      records.push(...err.records);
      skipLaterPhases(err.phase);
    } else if (err instanceof PhaseFailure) {
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

    // A step that failed because the lease was lost mid-step, or a lease lost
    // at any boundary: one record names it (#2748).
    if (work?.lost !== undefined) records.push(lostRecord());

    // Compensation: run onFailure phases in reverse order (best-effort). Skipped
    // on abort (Ctrl-C) — the user asked to stop, so don't start new work.
    // It runs whatever the work lease did, so it takes no work boundary.
    const compensation: GateContext = { ...gates, work: undefined, compensating: true };
    if (!signal?.aborted) {
      for (const phase of [...(config.onFailure ?? [])].reverse()) {
        try {
          records.push(...(await timedPhase(phase, compensation, signal)));
        } catch (compErr) {
          if (compErr instanceof PhaseFailure || compErr instanceof GateStop || compErr instanceof PointStop) {
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

    const failed = await settle(records, "fail");
    throw new OpRunFailure(
      {
        op: config.name,
        records,
        totalMs: Date.now() - start,
        status: "fail",
        startedAt,
        record: failed,
        ...(await finishWork("fail")),
        ...resumeFields(),
      },
      { cause: err },
    );
  }

  const record = await settle(records, "ok");
  return {
    op: config.name,
    records,
    totalMs: Date.now() - start,
    status: "ok",
    startedAt,
    record,
    ...(await finishWork("ok")),
    ...resumeFields(),
  };
}

/** A finished phase's verdict, as the run ledger folds it: `fail`, `skipped` when every step was, else `ok`. */
function phaseVerdict(records: readonly StepRecord[]): "ok" | "fail" | "skipped" {
  if (records.some((r) => r.status === "fail")) return "fail";
  if (records.length > 0 && records.every((r) => r.status === "skipped")) return "skipped";
  return "ok";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
