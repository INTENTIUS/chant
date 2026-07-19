/**
 * Structured progress events for `chant run --components <sel> --progress-json`
 * (behold roadmap M3: a consumer that renders live wave/phase/step progress
 * instead of tailing raw logs).
 *
 * This is purely additive observation over the interpret driver's existing
 * wave -> component -> phase -> step execution loop (./driver.ts): an
 * optional `onProgress` callback, threaded through
 * `runInterpretDriver`/`runComponentDeploy`/`runPhase` (and the CLI's
 * single-component path, ./cli-support.ts's `runComponents`), that never
 * changes run ordering, gating, `onFailure`, rollback, or exit codes — it
 * only reports what already happened, as it happens. See ./driver.ts's
 * module doc for what actually executes; streaming progress on the *durable*
 * (Temporal) path is a separate, later concern (Temporal already exposes
 * durable run state via `chant run status`/`log`).
 *
 * `RunProgressEvent` is a discriminated union on `type`, one JSON object per
 * NDJSON line (see `ndjsonProgressSink` below and
 * ../cli/handlers/run.ts's `--progress-json` wiring).
 */

/** Terminal status for a wave/component/phase/run — mirrors DriverStepRecord's ok/fail split, collapsed to the two outcomes a consumer renders progress against. */
export type RunProgressStatus = "ok" | "failed";

/** The run is about to start. `waves` are the parallel-safe waves the run will attempt, in order (see resolveComponentGraph) — 1-based wave numbers in every other event index into this array. */
export interface RunStartEvent {
  type: "run-start";
  waves: string[][];
}

/** A wave is about to start; its components may run concurrently (independent components share a wave). */
export interface WaveStartEvent {
  type: "wave-start";
  /** 1-based wave number. */
  wave: number;
  components: string[];
}

/** A component within a wave is about to start its `deploy` composition. */
export interface ComponentStartEvent {
  type: "component-start";
  wave: number;
  component: string;
}

/** A named phase of a component's composition is about to run its steps. Emitted for nested (fan-out) phases too, keyed by the nested phase's own name. */
export interface PhaseStartEvent {
  type: "phase-start";
  component: string;
  phase: string;
}

/** A single capability step within a phase — one event when it starts, one when it settles. */
export interface StepEvent {
  type: "step";
  component: string;
  phase: string;
  step: string;
  status: "running" | "ok" | "failed";
  /** Present only alongside `status: "failed"`, when the capability threw. */
  error?: string;
}

/** A phase finished — `ok` if every step in it succeeded, `failed` if any step failed (the phase's remaining steps were skipped, per the driver's fail-fast-within-a-phase semantics). */
export interface PhaseDoneEvent {
  type: "phase-done";
  component: string;
  phase: string;
  status: RunProgressStatus;
}

/** A component's `deploy` composition finished (after any saga rollback + component-level `rollback` phases the driver ran on failure). */
export interface ComponentDoneEvent {
  type: "component-done";
  wave: number;
  component: string;
  status: RunProgressStatus;
}

/** A wave finished — `failed` if any component in it failed, which also stops the run before any later wave starts. */
export interface WaveDoneEvent {
  type: "wave-done";
  wave: number;
  status: RunProgressStatus;
}

/** The run finished. Mirrors the driver's own terminal `DriverRunResult.ok` / exit code. */
export interface RunDoneEvent {
  type: "run-done";
  status: RunProgressStatus;
}

export type RunProgressEvent =
  | RunStartEvent
  | WaveStartEvent
  | ComponentStartEvent
  | PhaseStartEvent
  | StepEvent
  | PhaseDoneEvent
  | ComponentDoneEvent
  | WaveDoneEvent
  | RunDoneEvent;

/** A sink that receives progress events as they occur. The driver only ever calls this — it never writes to a stream directly, so it stays testable without stdout. */
export type RunProgressSink = (event: RunProgressEvent) => void;

/**
 * Build a sink that writes `JSON.stringify(event) + "\n"` to `write` (default:
 * `process.stdout.write`), one line per event, as they happen — the
 * `--progress-json` CLI wiring's sink (../cli/handlers/run.ts). Kept separate
 * from `driver-output.ts`'s end-of-run renderers: this emits *during* the
 * run, one line at a time; `renderDriverJson`/`renderDriverHuman` render the
 * completed `DriverRunResult` once, after the run finishes.
 */
export function ndjsonProgressSink(write: (chunk: string) => void = (s) => void process.stdout.write(s)): RunProgressSink {
  return (event) => write(JSON.stringify(event) + "\n");
}
