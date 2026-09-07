/**
 * The op-runtime seam (#2121, epic #2114).
 *
 * An Op is a convergent verb; *where* it runs is a separate question from
 * *what* it does. This module states that question once, as a provider
 * contract, so `chant run` has one dispatch path instead of a branch per
 * runtime. Core ships the `local` provider (./runtimes/local.ts) and never
 * imports a hosting lexicon; a lexicon that hosts runs implements
 * {@link OpRuntimeProvider} and hangs it off `LexiconPlugin.opRuntime`, where
 * `chant run <op> --on <lexicon>` finds it.
 *
 * The record shapes below are the run ledger's (#2118): what a run wrote to
 * `<env>/runs__<op>.jsonl` is what a provider's `status` and `log` read back,
 * so a run's outcome survives the process that produced it. A provider with no
 * ledger behind it (a hosting lexicon reporting a live run) fills the same
 * shape from whatever it does know.
 */

import type { OpConfig } from "./types";
import type { StepRecord, OpRunResult } from "./local-executor";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { RunComponentsOptions, RunComponentsResult } from "../components/cli-support";

/**
 * How a run ended, or that it has not. `gated` is the state a run reaches when
 * a gate has no recorded resolution — a fact, not a wait (#2119).
 *
 * This is the coarse state a *runtime* reports. The ledger records the
 * executor's own three-state outcome instead ({@link OpRunRecord.status}),
 * which has no `running` or `cancelled`: a record is only written once a run
 * has settled.
 */
export type OpRunState = "running" | "completed" | "failed" | "gated" | "cancelled";

/** Map a settled run's ledger status onto the coarser runtime state. */
export function runStateOf(status: OpRunRecord["status"]): OpRunState {
  return status === "ok" ? "completed" : status === "gated" ? "gated" : "failed";
}

/** One step's outcome as the run ledger keeps it — `StepRecord` minus the fields only a live renderer needs. */
export interface OpRunStepRecord {
  /** The activity function name, or `gate:<signal>` for a gate step. */
  fn: string;
  status: StepRecord["status"];
  durationMs: number;
  /** The step's `outcomeAttribute` capture, when it declared one. */
  outcome?: { name: string; value: unknown };
  /** Who cleared this gate step and when (#2119), for a gate the run passed. */
  approval?: { gate: string; resolvedBy: string; timestamp: string; url?: string };
  /** The failure message, for `status: "fail"`. */
  error?: string;
}

/** One phase's steps and the verdict they add up to. */
export interface OpRunPhaseRecord {
  name: string;
  /** `fail` if any step failed, `skipped` if every step was skipped, else `ok`. */
  status: "ok" | "fail" | "skipped";
  steps: OpRunStepRecord[];
}

/**
 * A run's current state, as every runtime reports it.
 *
 * `records` and `result` are populated by a runtime that has the executor's
 * own step records to hand (the local one does, for a run it just executed in
 * this process); a runtime answering from the ledger alone omits them rather
 * than inventing them.
 */
export interface OpRunStatus {
  op: string;
  runId: string;
  state: OpRunState;
  /** ISO-8601 instant the run started. */
  startedAt: string;
  /** ISO-8601 instant the run settled; absent while it is still running. */
  endedAt?: string;
  /** Per-step records, when the runtime has them. */
  records?: StepRecord[];
  /** The executor's own result, when the runtime is executing in this process. */
  result?: OpRunResult;
  /** The gate this run is waiting on, when `state` is `gated`. */
  gate?: { name: string; since: string };
  /** Free-text detail for a failed run. */
  error?: string;
}

/**
 * One immutable, settled Op run — the run ledger's line
 * (`../lifecycle/run-ledger.ts`), and what `chant run log <op>` prints a row
 * per.
 *
 * This is where a run's outcome lives now that `OpConfig` no longer carries
 * `searchAttributes` for the generated workflow to upsert (#2118). `labels` is
 * copied off the declaration so a reader can filter runs the way it filters
 * declarations; `outcomes` is every `outcomeAttribute` the run captured, later
 * steps winning over earlier ones for a repeated name, exactly as an upsert
 * would have.
 */
export interface OpRunRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** Stable run id — the same string a pending gate fact records for this run. */
  id: string;
  /** The Op's name (`OpConfig.name`). */
  op: string;
  /** The Op's `labels.Env`, or `local` when it declares none. */
  env: string;
  /** ISO-8601 instant the run started. */
  started: string;
  /** ISO-8601 instant the run settled. */
  ended: string;
  /**
   * The executor's three-state outcome. `gated` is neither success nor
   * failure: the run reached a gate nobody has approved, recorded the fact,
   * and stopped (#2119).
   */
  status: "ok" | "fail" | "gated";
  /** The Op's own `labels`, copied at run time. */
  labels: Record<string, string>;
  /** Every `outcomeAttribute` the run captured, name → value. */
  outcomes: Record<string, unknown>;
  /** Per-phase, per-step status, in execution order. */
  phases: OpRunPhaseRecord[];
  /** The gate the run stopped on, for `status: "gated"`. */
  gate?: { name: string; since: string };
}

/** An {@link OpRunRecord} before the ledger stamps its version and mints an id. */
export type OpRunRecordInput = Omit<OpRunRecord, "version" | "id"> & { id?: string };

/** A started run. `result()` settles with the run's final status. */
export interface OpRunHandle {
  op: string;
  runId: string;
  result(): Promise<OpRunStatus>;
}

/** What a caller hands a runtime when it starts a run. */
export interface OpRunStartOptions {
  /** Build-time parameter bindings, when the caller resolved any. */
  params?: Record<string, unknown>;
  /** Target environment (`--env`). */
  env?: string;
  /**
   * `-p, --profile <name>` (#2124, restored in #2192) — the named connection
   * profile this runtime should target. Only a runtime that has profiles
   * reads it; the local one ignores it, and a runtime that reads it decides
   * for itself what an unknown name means (fountain refuses it rather than
   * falling back to its default).
   */
  profile?: string;
  /** Called once per settled step, so `--progress-json` can stream. */
  progress?: (record: StepRecord) => void;
  /** Aborts in-flight work (Ctrl-C). */
  signal?: AbortSignal;
}

/**
 * The contract a runtime implements to host Op runs.
 *
 * `chant run` resolves exactly one provider per invocation — the named
 * lexicon's for `--on <name>`, the built-in `local` one otherwise — and every
 * subcommand calls it. A provider that cannot do something (cancel a
 * foreground run, host components) says so by throwing a message the CLI
 * prints verbatim, or by omitting the optional member.
 */
export interface OpRuntimeProvider {
  /** How the CLI names this runtime in messages, and what `--on` matches. */
  readonly name: string;

  /** Start a run. Rejects with an actionable Error when it cannot. */
  start(op: OpConfig, opts: OpRunStartOptions): Promise<OpRunHandle>;

  /** The latest run's state, or `undefined` when this runtime has none recorded. */
  status(op: string): Promise<OpRunStatus | undefined>;

  /** Run history, newest first. Empty when nothing is recorded. */
  log(op: string, opts?: { limit?: number }): Promise<OpRunRecord[]>;

  /** Latest state for each of `ops`, keyed by op name. */
  list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>>;

  /** Cancel the active run. `force` is the CLI's confirmation, already checked. */
  cancel(op: string, opts: { force: boolean }): Promise<void>;

  /**
   * Wake a run whose gate has just been resolved. The ledger write is the
   * fact and `chant approve` owns it; this is the runtime's chance to act on
   * it. Omit when a run re-reads the ledger on its own.
   */
  resolveGate?(op: string, gate: string, resolution: GateResolutionRecord): Promise<void>;

  /**
   * Host `chant run --components`. Optional: a runtime without it refuses the
   * flag with one line naming itself.
   */
  runComponents?(
    projectPath: string,
    selector: string,
    options: RunComponentsOptions,
  ): Promise<RunComponentsResult>;
}
