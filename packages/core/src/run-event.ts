/**
 * The run-event contract (#4019, behold #678): one stream of events for Op
 * runs, component runs and pipeline runs, so anything that shows a run reads
 * the same fields wherever the run happened.
 *
 * `workspace/run-event.schema.json` is the contract. These types
 * mirror it, and {@link createRunEventWriter} and {@link writeRunEvent} are
 * the one writer: every emitter hands a writer the type-specific body and
 * the writer stamps the run's identity, the sequence number, the time and the
 * contract fields on it, then writes one JSON line. The emitters themselves
 * are in `./run-event-stream.ts` and the runtimes (#4041); replay and
 * `--follow` are #4042's.
 *
 * Two older streams predate this one and keep their shape behind
 * `--progress-json`, while `--events-json` prints this one (#4041):
 * `RunProgressEvent` (`./components/run-progress.ts`, from `chant run
 * --components --progress-json`) and the Op path's `StepRecord` lines
 * (`./op/local-executor.ts`, from `chant run <op> --progress-json`).
 * {@link runEventOfProgress} and {@link runEventsOfStepRecord} say how each
 * maps onto this contract.
 *
 * This module imports no runtime code beyond the chant version (`./chant-version.ts`), so a consumer
 * can import the types and the writer without loading the rest of chant. It
 * lives outside `workspace/` so that a level-0 import of `@intentius/chant`
 * loads no workspace module (#2526).
 */

import type { RunProgressEvent } from "./components/run-progress";
import type { RunOrigin } from "./lifecycle/release-ledger";
import type { StepRecord } from "./op/local-executor";
import { CHANT_VERSION } from "./chant-version";

/** The schema's `$id`, which every event carries as `$schema`. */
export const RUN_EVENT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/run-event/v1/run-event.schema.json";

/** The contract version every event carries as `contract`. */
export const RUN_EVENT_CONTRACT_VERSION = 1;

/** The first chant that writes contract version 1 of the run-event stream. */
export const RUN_EVENT_FLOOR = "0.124.28";

/** What ran: an Op, a component selection (`chant run --components`), or a CI pipeline. */
export type RunEventKind = "op" | "component" | "pipeline";

/** Where the run happened: in the process that started it, on a steward, or in a forge's CI. */
export type RunEventRuntime = "local" | "steward" | "ci";

/** How a run, wave, component or phase settled. `gated` and `waiting` wait on a person and are not failures. */
export type RunEventSettleStatus = "ok" | "failed" | "gated" | "waiting";

/**
 * How a step settled. `skipped` says why in {@link RunEventStepSettle.skip};
 * `cached` is for a cache hit standing in for the step (#4015).
 */
export type RunEventStepStatus = "ok" | "failed" | "skipped" | "cached" | "gated" | "waiting";

/** Why a step was skipped. */
export type RunEventSkipReason = "receipt" | "resumed" | "refused" | "not-run";

/** How a gate's approval passed, when it was more than one person's approval of that gate. */
export type RunEventGateVia = "quorum" | "policy" | "point" | "alias";

/** The run every event of a stream names: the same on every line. */
export interface RunEventRun {
  /** The run's id, in the id space `runOrigin.forge` names. */
  runId: string;
  kind: RunEventKind;
  /** The Op's name, the component selection as given, or the pipeline's name. */
  name: string;
  /** The commit the run built from, or null when it did not start in a git checkout. */
  gitSha: string | null;
  runtime: RunEventRuntime;
  /** The locator: the shape a release record's `runOrigin` has. */
  runOrigin: RunOrigin;
}

/** What every event carries besides its body. */
export interface RunEventEnvelope extends RunEventRun {
  $schema: typeof RUN_EVENT_SCHEMA_ID;
  contract: typeof RUN_EVENT_CONTRACT_VERSION;
  /** The version of the chant that wrote the event. */
  chant: string;
  /** The event's place in its run's stream, from 0 at `run-start`. */
  seq: number;
  /** When it happened, ISO-8601. */
  at: string;
}

export interface RunEventRunStart {
  type: "run-start";
  /** In a component run, the waves the run will attempt, in order. Null in an Op or pipeline run. */
  waves: string[][] | null;
}

/** The last event of a stream. Its `status` is the run's verdict. */
export interface RunEventRunSettle {
  type: "run-settle";
  status: RunEventSettleStatus;
  durationMs: number | null;
  error?: string;
}

export interface RunEventWaveStart {
  type: "wave-start";
  /** 1-based, into `run-start`'s `waves`. */
  wave: number;
  components: string[];
}

export interface RunEventWaveSettle {
  type: "wave-settle";
  wave: number;
  status: RunEventSettleStatus;
}

export interface RunEventComponentStart {
  type: "component-start";
  wave: number;
  component: string;
}

export interface RunEventComponentSettle {
  type: "component-settle";
  wave: number;
  component: string;
  status: RunEventSettleStatus;
}

/** An Op's phase, a component composition's phase, or a pipeline's stage. `component` is null outside a component run. */
export interface RunEventPhaseStart {
  type: "phase-start";
  component: string | null;
  phase: string;
}

export interface RunEventPhaseSettle {
  type: "phase-settle";
  component: string | null;
  phase: string;
  status: RunEventSettleStatus;
}

/** An Op or composition step, or a pipeline's job. */
export interface RunEventStepStart {
  type: "step-start";
  component: string | null;
  phase: string;
  /** The activity, `gate:<name>`, `effect:<name>`, or the job's name. */
  step: string;
  /**
   * The step's place in its phase as authored, from 0, so two steps of one
   * phase that share a name stay apart. Optional: added within contract 1 by
   * chant 0.124.28 (#4041), and left out where the writer has no authored
   * position, such as a step the executor adds itself.
   */
  index?: number;
}

export interface RunEventStepSettle {
  type: "step-settle";
  component: string | null;
  phase: string;
  step: string;
  /** As on {@link RunEventStepStart.index}. */
  index?: number;
  status: RunEventStepStatus;
  /** With `skipped`: why, or null when the writer does not know. */
  skip?: RunEventSkipReason | null;
  durationMs: number | null;
  /** With `failed`: what failed. */
  error?: string;
  /** Why the step skipped, gated or waited, for a person. */
  message?: string;
}

/** The run stopped at a gate nobody has approved, or a decision point nobody has answered. */
export interface RunEventGateWaiting {
  type: "gate-waiting";
  component: string | null;
  phase: string;
  step: string;
  /** As on {@link RunEventStepStart.index}. */
  index?: number;
  /** The op the gate is recorded under, which `chant approve` takes. */
  op: string;
  /** The gate's name, or null when the step waits on a decision point alone. */
  gate: string | null;
  /** The open question's answer record id, or null. */
  point: string | null;
  message?: string;
}

export interface RunEventGateResolved {
  type: "gate-resolved";
  component: string | null;
  phase: string;
  step: string;
  /** As on {@link RunEventStepStart.index}. */
  index?: number;
  op: string;
  gate: string;
  resolvedBy: string;
  resolvedAt: string;
  via: RunEventGateVia | null;
  url?: string;
}

/** The type-specific part of an event: what an emitter hands the writer. */
export type RunEventBody =
  | RunEventRunStart
  | RunEventRunSettle
  | RunEventWaveStart
  | RunEventWaveSettle
  | RunEventComponentStart
  | RunEventComponentSettle
  | RunEventPhaseStart
  | RunEventPhaseSettle
  | RunEventStepStart
  | RunEventStepSettle
  | RunEventGateWaiting
  | RunEventGateResolved;

export type RunEventType = RunEventBody["type"];

/** Every event type, in the order a reader meets them. Closed: part of the contract. */
export const RUN_EVENT_TYPES = [
  "run-start",
  "wave-start",
  "component-start",
  "phase-start",
  "step-start",
  "gate-waiting",
  "gate-resolved",
  "step-settle",
  "phase-settle",
  "component-settle",
  "wave-settle",
  "run-settle",
] as const satisfies readonly RunEventType[];

/** One line of a run's stream. */
export type RunEvent = RunEventBody extends infer B ? (B extends RunEventBody ? RunEventEnvelope & B : never) : never;

/** One event as its line: JSON with the envelope first, then the body, and a newline. */
export function serializeRunEvent(event: RunEvent): string {
  return JSON.stringify(event) + "\n";
}

/** What {@link writeRunEvent} and {@link createRunEventWriter} need besides the body. */
export interface RunEventStamp {
  run: RunEventRun;
  seq: number;
  /** When it happened. Defaults to now. */
  at?: Date | string;
  /** Defaults to this chant's version. */
  chant?: string;
}

/**
 * Build one event from its body and the run it belongs to. The envelope's
 * fields come first, so every line reads the same way. No body names an
 * envelope field, so neither overrides the other.
 */
export function buildRunEvent(body: RunEventBody, stamp: RunEventStamp): RunEvent {
  const at = stamp.at === undefined ? new Date().toISOString() : typeof stamp.at === "string" ? stamp.at : stamp.at.toISOString();
  const { runId, kind, name, gitSha, runtime, runOrigin } = stamp.run;
  const envelope: RunEventEnvelope = {
    $schema: RUN_EVENT_SCHEMA_ID,
    contract: RUN_EVENT_CONTRACT_VERSION,
    chant: stamp.chant ?? CHANT_VERSION,
    seq: stamp.seq,
    at,
    runId,
    kind,
    name,
    gitSha,
    runtime,
    runOrigin,
  };
  return { ...envelope, ...body } as RunEvent;
}

/** Build one event and hand its line to `write`. Returns the event written. */
export function writeRunEvent(body: RunEventBody, stamp: RunEventStamp, write: (line: string) => void): RunEvent {
  const event = buildRunEvent(body, stamp);
  write(serializeRunEvent(event));
  return event;
}

/** A run's writer: it keeps the run and the sequence, so an emitter hands it bodies only. */
export interface RunEventWriter {
  /** Write the next event of the run and return it. */
  emit(body: RunEventBody): RunEvent;
  /** The `seq` the next event gets. */
  readonly next: number;
}

export interface RunEventWriterOptions {
  run: RunEventRun;
  /** Where each line goes. Defaults to standard output. */
  write?: (line: string) => void;
  /** The clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** The `seq` of the first event, for a writer that carries on a stream. Defaults to 0. */
  seq?: number;
  /** Defaults to this chant's version. */
  chant?: string;
}

/** The one writer of a run's stream (#4019). Each `emit` writes one line and moves the sequence on. */
export function createRunEventWriter(opts: RunEventWriterOptions): RunEventWriter {
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const now = opts.now ?? (() => new Date());
  let seq = opts.seq ?? 0;
  return {
    emit(body) {
      return writeRunEvent(body, { run: opts.run, seq: seq++, at: now(), chant: opts.chant }, write);
    },
    get next() {
      return seq;
    },
  };
}

// ── The older streams, in terms of this one ─────────────────────────────────

/**
 * A `RunProgressEvent` (`chant run --components --progress-json`) as a
 * run-event body. The older stream has no step timings, so `durationMs` is
 * null on the settles it maps to.
 */
export function runEventOfProgress(event: RunProgressEvent): RunEventBody {
  switch (event.type) {
    case "run-start":
      return { type: "run-start", waves: event.waves };
    case "wave-start":
      return { type: "wave-start", wave: event.wave, components: event.components };
    case "component-start":
      return { type: "component-start", wave: event.wave, component: event.component };
    case "phase-start":
      return { type: "phase-start", component: event.component, phase: event.phase };
    case "step":
      if (event.status === "running") return { type: "step-start", component: event.component, phase: event.phase, step: event.step };
      return {
        type: "step-settle",
        component: event.component,
        phase: event.phase,
        step: event.step,
        status: event.status,
        durationMs: null,
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
    case "phase-done":
      return { type: "phase-settle", component: event.component, phase: event.phase, status: event.status };
    case "component-done":
      return { type: "component-settle", wave: event.wave, component: event.component, status: event.status };
    case "wave-done":
      return { type: "wave-settle", wave: event.wave, status: event.status };
    case "run-done":
      return { type: "run-settle", status: event.status, durationMs: null };
  }
}

const GATE_PREFIX = "gate:";

/**
 * A settled `StepRecord` (`chant run <op> --progress-json`) as run-event
 * bodies: a gate's `gate-resolved` or `gate-waiting` when the record carries
 * one, then the `step-settle`. `op` is the run's Op, which a gate is recorded
 * under unless the record names another.
 *
 * A record skipped with nothing to say why maps to `skip: null`. The local
 * executor writes the same record for a gate nobody has approved, for a step
 * of an effect whose receipt matched and for a step an earlier failure
 * stopped, so only an emitter that knows which can say `gated`, `receipt` or
 * `not-run`. The run's own status still says `gated`. The local executor
 * (#4041) knows, and passes `skip` for a bare skipped record and `gate` for
 * a gate step nobody has approved; it passes `index`, the step's place in
 * its phase, too.
 */
export function runEventsOfStepRecord(
  record: StepRecord,
  ctx: {
    op: string;
    component?: string | null;
    skip?: RunEventSkipReason;
    index?: number;
    /** The gate a skipped gate step stopped at, when the emitter knows it. */
    gate?: { op: string; gate: string };
  },
): RunEventBody[] {
  const component = ctx.component ?? null;
  const at = { component, phase: record.phase, step: record.fn, ...(ctx.index !== undefined ? { index: ctx.index } : {}) };
  const out: RunEventBody[] = [];
  const settle = (status: RunEventStepStatus, extra: Partial<RunEventStepSettle> = {}): RunEventStepSettle => ({
    type: "step-settle",
    ...at,
    status,
    durationMs: record.durationMs,
    ...extra,
  });
  const gateOfFn = record.fn.startsWith(GATE_PREFIX) ? record.fn.slice(GATE_PREFIX.length) : null;

  if (record.approval) {
    const a = record.approval;
    out.push({
      type: "gate-resolved",
      ...at,
      op: ctx.op,
      gate: a.gate,
      resolvedBy: a.resolvedBy,
      resolvedAt: a.timestamp,
      via: a.via ?? null,
      ...(a.url !== undefined ? { url: a.url } : {}),
    });
  }
  if (record.status === "ok") {
    out.push(settle("ok"));
    return out;
  }
  if (record.status === "fail") {
    out.push(settle("failed", record.error !== undefined ? { error: record.error } : {}));
    return out;
  }
  const message = record.refusal !== undefined ? { message: record.refusal } : {};
  const stoppedAt = record.gate ?? ctx.gate;
  if (record.point) {
    out.push({ type: "gate-waiting", ...at, op: ctx.op, gate: gateOfFn, point: record.point.id, ...message });
    out.push(settle("waiting", message));
  } else if (stoppedAt) {
    out.push({ type: "gate-waiting", ...at, op: stoppedAt.op, gate: stoppedAt.gate, point: null, ...message });
    out.push(settle("gated", message));
  } else if (gateOfFn !== null && record.refusal !== undefined) {
    out.push({ type: "gate-waiting", ...at, op: ctx.op, gate: gateOfFn, point: null, ...message });
    out.push(settle("gated", message));
  } else if (record.resumed) {
    out.push(settle("skipped", { skip: "resumed", message: `resumed at gate ${record.resumed.gate} from run ${record.resumed.run}` }));
  } else if (record.refusal !== undefined) {
    out.push(settle("skipped", { skip: "refused", ...message }));
  } else {
    out.push(settle("skipped", { skip: ctx.skip ?? null }));
  }
  return out;
}
