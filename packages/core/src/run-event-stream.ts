/**
 * The emitters' side of the run-event contract (#4041): what a runtime or a
 * command needs to print a run's stream through the one writer in
 * `./run-event.ts`.
 *
 * Every emitter hands bodies to a {@link RunEventSink}. The CLI opens a
 * {@link RunEventStream} over a run's identity, which stamps each body
 * through `createRunEventWriter` and makes sure the stream opens with
 * `run-start` and ends with one `run-settle`, even when the run threw before
 * it said so itself. The components driver emits bodies only, and
 * {@link progressOfRunEvent} turns them back into the older
 * `RunProgressEvent` lines that `--progress-json` still prints.
 *
 * Kept apart from `./run-event.ts`, which a level-0 import loads: this
 * module reads git and the CI environment.
 */

import type { RunProgressEvent } from "./components/run-progress";
import type { GateCheck } from "./op/gate";
import { resolveCommitSha } from "./lifecycle/commit-sha";
import { resolveCiRun, type RunOrigin } from "./lifecycle/release-ledger";
import {
  createRunEventWriter,
  type RunEventBody,
  type RunEventKind,
  type RunEventRun,
  type RunEventRuntime,
  type RunEventSettleStatus,
} from "./run-event";

/** Where an emitter hands a run's events, before the writer stamps them. */
export type RunEventSink = (body: RunEventBody) => void;

/** One sink that hands each body to every sink given, or undefined when none is. */
export function joinRunEventSinks(...sinks: Array<RunEventSink | undefined>): RunEventSink | undefined {
  const live = sinks.filter((s): s is RunEventSink => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return (body) => {
    for (const sink of live) sink(body);
  };
}

const GATE_PREFIX = "gate:";

/**
 * A run-event body as the older `RunProgressEvent`, or undefined when that
 * stream had no such event. It never printed a gate step, a skipped step,
 * a phase outside a component or a gate's decision, so those map to nothing
 * and `--progress-json` prints what it printed before #4041.
 */
export function progressOfRunEvent(body: RunEventBody): RunProgressEvent | undefined {
  const progressStatus = (s: RunEventSettleStatus): "ok" | "failed" | "gated" => (s === "waiting" ? "gated" : s);
  switch (body.type) {
    case "run-start":
      return { type: "run-start", waves: body.waves ?? [] };
    case "wave-start":
      return { type: "wave-start", wave: body.wave, components: body.components };
    case "component-start":
      return { type: "component-start", wave: body.wave, component: body.component };
    case "phase-start":
      return body.component === null ? undefined : { type: "phase-start", component: body.component, phase: body.phase };
    case "step-start":
      if (body.component === null || body.step.startsWith(GATE_PREFIX)) return undefined;
      return { type: "step", component: body.component, phase: body.phase, step: body.step, status: "running" };
    case "step-settle":
      if (body.component === null || body.step.startsWith(GATE_PREFIX)) return undefined;
      if (body.status !== "ok" && body.status !== "failed") return undefined;
      return {
        type: "step",
        component: body.component,
        phase: body.phase,
        step: body.step,
        status: body.status,
        ...(body.error !== undefined ? { error: body.error } : {}),
      };
    case "phase-settle":
      return body.component === null
        ? undefined
        : { type: "phase-done", component: body.component, phase: body.phase, status: progressStatus(body.status) };
    case "component-settle":
      return { type: "component-done", wave: body.wave, component: body.component, status: progressStatus(body.status) };
    case "wave-settle":
      return { type: "wave-done", wave: body.wave, status: progressStatus(body.status) };
    case "run-settle":
      return { type: "run-done", status: progressStatus(body.status) };
    case "gate-waiting":
    case "gate-resolved":
      return undefined;
  }
}

/** A `RunProgressEvent` callback as a sink of run-event bodies, through {@link progressOfRunEvent}. */
export function progressSinkOf(onProgress: ((event: RunProgressEvent) => void) | undefined): RunEventSink | undefined {
  if (!onProgress) return undefined;
  return (body) => {
    const event = progressOfRunEvent(body);
    if (event) onProgress(event);
  };
}

/** The CI run the environment names, as `resolveCiRun` gives it. */
type CiRun = { runId: string; runOrigin: RunOrigin };

/**
 * A run's identity from what the emitter already knows. The runtime is `ci`
 * inside a CI job, `steward` in a steward's turn and `local` otherwise; the
 * origin is the CI run's, `op` for a steward's run, and `local` otherwise. An
 * Op run keeps its own run id in CI, as its run record does (#4020).
 */
export function runEventRunOf(input: {
  kind: RunEventKind;
  name: string;
  runId: string;
  gitSha?: string;
  ci?: CiRun;
  steward?: boolean;
  runtime?: RunEventRuntime;
  runOrigin?: RunOrigin;
}): RunEventRun {
  return {
    runId: input.runId,
    kind: input.kind,
    name: input.name,
    gitSha: input.gitSha ?? null,
    runtime: input.runtime ?? (input.ci ? "ci" : input.steward ? "steward" : "local"),
    runOrigin: input.runOrigin ?? input.ci?.runOrigin ?? (input.steward ? { forge: "op" } : { forge: "local" }),
  };
}

/**
 * A run's identity, resolved: the commit from `resolveCommitSha` and the CI
 * run from `resolveCiRun` (#4020). Without `runId`, a CI run is named by its
 * CI run id and any other by a locally minted `local-<ms>` id, the spelling
 * `resolveRunId` uses for a release record.
 */
export async function resolveRunEventRun(input: {
  kind: RunEventKind;
  name: string;
  runId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RunEventRun> {
  const env = input.env ?? process.env;
  const ci = resolveCiRun(env);
  const gitSha = await resolveCommitSha({ ...(input.cwd ? { cwd: input.cwd } : {}), env });
  const runId = input.runId ?? ci?.runId ?? `local-${Date.now()}`;
  // An explicit id that is not the CI run's lives in no CI id space.
  const inCiSpace = ci !== undefined && runId === ci.runId;
  return runEventRunOf({
    kind: input.kind,
    name: input.name,
    runId,
    ...(gitSha ? { gitSha } : {}),
    ...(ci ? { ci } : {}),
    ...(ci && !inCiSpace ? { runOrigin: { forge: "local" } } : {}),
  });
}

/** One run's stream: the writer, held to the shape the contract promises. */
export interface RunEventStream {
  /** The run every event names. */
  readonly run: RunEventRun;
  /** Write a body. */
  emit: RunEventSink;
  /**
   * A sink for a part of the run that frames itself as a whole run, such as
   * the fan-out a pull request's apply runs: its `run-start` and
   * `run-settle` are dropped, and the caller settles the run.
   */
  nested: RunEventSink;
  /** End the stream with `run-settle`, unless it has ended. */
  settle(status: RunEventSettleStatus, error?: string): void;
  /** Whether `run-settle` has been written. */
  readonly settled: boolean;
}

/**
 * Open a run's stream over `write`. The first event is always `run-start`
 * (one with `waves: null` is written first when the emitter starts with
 * something else), a second `run-start` is dropped, `run-settle` gets the
 * time since `run-start` when the emitter did not time it, and nothing is
 * written after `run-settle`.
 */
export function openRunEventStream(
  run: RunEventRun,
  write: (line: string) => void,
  opts: { now?: () => Date; chant?: string } = {},
): RunEventStream {
  const now = opts.now ?? (() => new Date());
  const writer = createRunEventWriter({ run, write, now, ...(opts.chant ? { chant: opts.chant } : {}) });
  let startedAt: number | undefined;
  let settled = false;

  const emit: RunEventSink = (body) => {
    if (settled) return;
    if (body.type === "run-start") {
      if (startedAt !== undefined) return;
      startedAt = now().getTime();
      writer.emit(body);
      return;
    }
    if (startedAt === undefined) emit({ type: "run-start", waves: null });
    if (body.type === "run-settle") {
      settled = true;
      writer.emit(body.durationMs === null ? { ...body, durationMs: Math.max(0, now().getTime() - startedAt!) } : body);
      return;
    }
    writer.emit(body);
  };

  return {
    run,
    emit,
    nested: (body) => {
      if (body.type !== "run-start" && body.type !== "run-settle") emit(body);
    },
    settle(status, error) {
      if (settled) return;
      emit({ type: "run-settle", status, durationMs: null, ...(error !== undefined ? { error } : {}) });
    },
    get settled() {
      return settled;
    },
  };
}

/** Where a gate step sits, for {@link gateEventsOf}. */
export interface GateStepAt {
  component: string | null;
  phase: string;
  /** `gate:<name>`. */
  step: string;
  index?: number;
  /** The op the gate is recorded under. */
  op: string;
  gate: string;
}

/**
 * A decided gate as events: `gate-resolved` and an `ok` settle when an
 * approval stands, `gate-waiting` and a `gated` settle when none does.
 * `message` says why it did not pass, for a person.
 */
export function gateEventsOf(check: GateCheck, at: GateStepAt, opts: { durationMs: number | null; message?: string }): RunEventBody[] {
  const where = { component: at.component, phase: at.phase, step: at.step, ...(at.index !== undefined ? { index: at.index } : {}) };
  const message = opts.message !== undefined ? { message: opts.message } : {};
  if (check.satisfied) {
    return [
      {
        type: "gate-resolved",
        ...where,
        op: at.op,
        gate: at.gate,
        resolvedBy: check.resolution.resolvedBy,
        resolvedAt: check.resolution.timestamp,
        via: check.via ?? null,
        ...(check.resolution.url ? { url: check.resolution.url } : {}),
      },
      { type: "step-settle", ...where, status: "ok", durationMs: opts.durationMs },
    ];
  }
  return [
    { type: "gate-waiting", ...where, op: check.pending.op, gate: at.gate, point: null, ...message },
    { type: "step-settle", ...where, status: "gated", durationMs: opts.durationMs, ...message },
  ];
}

/** The phase a gate outside any component is the one step of: a fan-out's, a wave's or a pull request's. */
export const GATE_PHASE = "gate";

/**
 * Decide a gate that stands outside any component, and emit it as the one
 * step of a {@link GATE_PHASE} phase: `phase-start`, `step-start`, the
 * decision through {@link gateEventsOf}, the settle and `phase-settle`. A
 * decision that throws settles the step `failed` and is rethrown. `message`
 * says, for a person, why a gate that did not pass did not.
 */
export async function emitGateStep(
  emit: RunEventSink | undefined,
  at: { op: string; gate: string },
  decide: () => Promise<GateCheck>,
  message?: (check: Extract<GateCheck, { satisfied: false }>) => string | undefined,
): Promise<GateCheck> {
  const where = { component: null, phase: GATE_PHASE, step: `gate:${at.gate}` };
  emit?.({ type: "phase-start", component: null, phase: GATE_PHASE });
  emit?.({ type: "step-start", ...where });
  const start = Date.now();
  let check: GateCheck;
  try {
    check = await decide();
  } catch (err) {
    emit?.({ type: "step-settle", ...where, status: "failed", durationMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) });
    emit?.({ type: "phase-settle", component: null, phase: GATE_PHASE, status: "failed" });
    throw err;
  }
  const why = check.satisfied
    ? undefined
    : (message?.(check) ?? (check.mismatch ? "an approval stands for this gate, but for another plan" : undefined));
  for (const body of gateEventsOf(check, { ...where, op: at.op, gate: at.gate }, { durationMs: Date.now() - start, ...(why !== undefined ? { message: why } : {}) })) {
    emit?.(body);
  }
  emit?.({ type: "phase-settle", component: null, phase: GATE_PHASE, status: check.satisfied ? "ok" : "gated" });
  return check;
}
