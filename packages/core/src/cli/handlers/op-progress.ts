/**
 * Per-phase progress reconstructed from a Temporal Op workflow's history
 * (chant #1676) — the durable-path counterpart to the local executor's
 * `StepRecord[]` (op/local-executor.ts), so `chant run <name> --temporal
 * --progress-json` and `op-status` can report the same shape `chant run
 * <name> --json` already does for the local path, instead of the two raw
 * `ActivityTaskScheduled`/`ActivityTaskCompleted` counts.
 *
 * A step is joined to its declared (phase, fn) by position, not by name: the
 * declared step list (`declaredStepOrder`, mirroring the serializer's own
 * `collectActivitySteps` traversal — main phases, then `onFailure` phases
 * *reversed*, matching how the generated workflow actually runs them) is
 * walked in order, and each step consumes the next not-yet-consumed
 * `ActivityTaskScheduled` event whose activity type matches its `fn` — a
 * per-fn FIFO queue, not a global "does this name appear anywhere" scan.
 * Two steps calling the same activity therefore each get their own
 * scheduled event instead of the later one overwriting the earlier
 * (the collision the prior `run-report.ts` join had). A step whose queue is
 * empty never ran this execution — an untaken effect branch, or an
 * `onFailure` phase on a run that succeeded.
 */

import type { OpConfig, PhaseDefinition } from "../../op/types";
import type { StepRecord } from "../../op/local-executor";
import type { WorkflowHistoryRaw, HistoryEvent, WorkflowHandleRaw } from "./run-client";

// Synthesized step names an effect step's read-compare-run-write compiles
// to (lexicons/temporal/src/op/serializer.ts's RECEIPT_READ_STEP/
// RECEIPT_WRITE_STEP) — duplicated here rather than imported so this module
// stays lexicon-free, same constraint as op/local-executor.ts.
const RECEIPT_READ_FN = "receiptRead";
const RECEIPT_WRITE_FN = "receiptWrite";

interface DeclaredStep {
  phase: string;
  fn: string;
}

function flattenPhases(phases: PhaseDefinition[]): DeclaredStep[] {
  const out: DeclaredStep[] = [];
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.kind === "activity") {
        out.push({ phase: phase.name, fn: step.fn });
      } else if (step.kind === "effect") {
        out.push({ phase: phase.name, fn: RECEIPT_READ_FN });
        for (const nested of step.steps) {
          if (nested.kind === "activity") out.push({ phase: phase.name, fn: nested.fn });
        }
        out.push({ phase: phase.name, fn: RECEIPT_WRITE_FN });
      }
      // Gate steps schedule no activity — nothing to join them to.
    }
  }
  return out;
}

/** Declared order matching actual scheduling order: main phases, then `onFailure` reversed (compensation runs last-declared-first — serializer.ts's `renderPhases([...config.onFailure].reverse())`). */
function declaredStepOrder(config: OpConfig): DeclaredStep[] {
  return [...flattenPhases(config.phases), ...flattenPhases([...(config.onFailure ?? [])].reverse())];
}

interface ScheduledEntry {
  scheduledEventId: string;
  scheduledAt?: Date;
}

/** Every `ActivityTaskScheduled` event, grouped by activity type name, in chronological order. */
function scheduledQueues(events: HistoryEvent[]): Map<string, ScheduledEntry[]> {
  const byFn = new Map<string, ScheduledEntry[]>();
  for (const e of events) {
    if (e.eventType !== "ActivityTaskScheduled") continue;
    const attrs = e.activityTaskScheduledEventAttributes;
    if (!attrs) continue;
    const fn = attrs.activityType?.name ?? "unknown";
    if (!byFn.has(fn)) byFn.set(fn, []);
    byFn.get(fn)!.push({ scheduledEventId: e.eventId ?? "", scheduledAt: e.eventTime });
  }
  return byFn;
}

interface TerminalOutcome {
  status: "ok" | "fail";
  at?: Date;
  error?: string;
}

/**
 * The terminal outcome of each scheduled activity, keyed by the scheduling
 * event's own id. A retried activity emits one `ActivityTaskFailed` per
 * attempt under the same `scheduledEventId`; walking events in order and
 * always overwriting on a later event leaves whichever came last —
 * `ActivityTaskCompleted` on an eventual success, otherwise the final
 * attempt's failure.
 */
function terminalOutcomes(events: HistoryEvent[]): Map<string, TerminalOutcome> {
  const out = new Map<string, TerminalOutcome>();
  for (const e of events) {
    if (e.eventType === "ActivityTaskCompleted" && e.activityTaskCompletedEventAttributes) {
      const id = e.activityTaskCompletedEventAttributes.scheduledEventId;
      if (id) out.set(id, { status: "ok", at: e.eventTime });
    } else if (e.eventType === "ActivityTaskFailed" && e.activityTaskFailedEventAttributes) {
      const id = e.activityTaskFailedEventAttributes.scheduledEventId;
      if (id) {
        out.set(id, {
          status: "fail",
          at: e.eventTime,
          error: e.activityTaskFailedEventAttributes.failure?.message ?? "unknown error",
        });
      }
    }
  }
  return out;
}

/**
 * A step record paired with the position of the declared step it came from.
 *
 * `index` is an offset into `declaredStepOrder(config)`, which depends only
 * on the Op config — not on the history — so it is the record's identity
 * and is stable across polls. The record *list* is not: a mid-run poll omits
 * every step that hasn't settled yet, and the terminal `final: true` pass
 * inserts a `"skipped"` record at each such step's declared position, which
 * shifts every later record's list offset (chant #2032). Anything tracking
 * what it has already seen must key on `index`, never on how many records
 * the previous call returned.
 */
export interface IndexedStepRecord {
  index: number;
  record: StepRecord;
}

/**
 * Reconstruct per-step progress records from a workflow's history, in
 * declared order, each tagged with its declared-step `index`. Only settled
 * steps (matched to a scheduled event that has since completed or failed)
 * produce a record — a step that hasn't been scheduled yet simply isn't in
 * the result. Pass `final: true` once the workflow has reached a terminal
 * status to also emit a `"skipped"` record for every declared step that
 * never got a matching scheduled event (an untaken effect branch, or an
 * `onFailure` phase on a run that succeeded) — never before, or a
 * still-running Op would show its not-yet-reached steps as skipped.
 */
export function extractIndexedStepRecords(
  config: OpConfig,
  history: WorkflowHistoryRaw,
  opts: { final?: boolean } = {},
): IndexedStepRecord[] {
  const events = history.events ?? [];
  const queues = scheduledQueues(events);
  const terminals = terminalOutcomes(events);
  const nextIndex = new Map<string, number>();

  const records: IndexedStepRecord[] = [];
  const declared = declaredStepOrder(config);
  for (let index = 0; index < declared.length; index++) {
    const step = declared[index];
    const queue = queues.get(step.fn);
    const idx = nextIndex.get(step.fn) ?? 0;
    const entry = queue?.[idx];
    if (!entry) {
      if (opts.final) {
        records.push({ index, record: { phase: step.phase, fn: step.fn, status: "skipped", durationMs: 0 } });
      }
      continue;
    }
    nextIndex.set(step.fn, idx + 1);

    const terminal = terminals.get(entry.scheduledEventId);
    if (!terminal) continue; // scheduled but not yet settled

    const durationMs =
      entry.scheduledAt && terminal.at ? terminal.at.getTime() - entry.scheduledAt.getTime() : 0;
    records.push({
      index,
      record: {
        phase: step.phase,
        fn: step.fn,
        status: terminal.status,
        durationMs,
        ...(terminal.error ? { error: terminal.error } : {}),
      },
    });
  }
  return records;
}

/** `extractIndexedStepRecords` without the indices — the plain declared-order record list. */
export function extractStepRecords(
  config: OpConfig,
  history: WorkflowHistoryRaw,
  opts: { final?: boolean } = {},
): StepRecord[] {
  return extractIndexedStepRecords(config, history, opts).map((r) => r.record);
}

/**
 * A sink that forwards each declared step's record exactly once, however many
 * times the poll loop re-derives the list.
 *
 * `--progress-json` calls this per poll with the whole list so far, plus once
 * more with the terminal `final: true` list. Deduplicating by declared-step
 * `index` is what makes that safe: an emitted-count watermark assumed the list
 * was append-only, and the `final` pass's inserted `"skipped"` records break
 * that assumption — with an unreached phase declared before an `onFailure`
 * phase that ran, the insertion shifted the tail, so the last record shipped
 * twice and the skipped one never shipped at all (chant #2032).
 */
export function stepRecordEmitter(emit: (record: StepRecord) => void): (records: IndexedStepRecord[]) => void {
  const seen = new Set<number>();
  return (records) => {
    for (const { index, record } of records) {
      if (seen.has(index)) continue;
      seen.add(index);
      emit(record);
    }
  };
}

/** `{completed, scheduled}` activity counts for the summary line `chant run status`/`op-status` show alongside the full record list. */
export function countActivities(history: WorkflowHistoryRaw): { completed: number; scheduled: number } {
  const events = history.events ?? [];
  return {
    completed: events.filter((e) => e.eventType === "ActivityTaskCompleted").length,
    scheduled: events.filter((e) => e.eventType === "ActivityTaskScheduled").length,
  };
}

/** The `gateState` workflow query's result (op/serializer.ts's `emitGate`) — the gate currently blocking the workflow, or `null` when none is pending. */
export interface GateQueryResult {
  signalName: string;
  description?: string;
  since: string;
}

/**
 * Best-effort `gateState` query. `undefined` (as opposed to `null`) means
 * the query itself failed — an Op with no gate steps never registers a
 * `gateState` handler, so querying it is expected to fail, not an error
 * worth surfacing.
 */
export async function queryGateState(handle: WorkflowHandleRaw): Promise<GateQueryResult | null | undefined> {
  try {
    return await handle.query<GateQueryResult | null>("gateState");
  } catch {
    return undefined;
  }
}
