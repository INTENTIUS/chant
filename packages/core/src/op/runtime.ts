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
 * The record shapes below are deliberately small. #2118 owns the ledger-backed
 * shape; reconcile at merge — until then the local provider derives status and
 * log from an in-memory `OpRunResult`.
 */

import type { OpConfig } from "./types";
import type { StepRecord, OpRunResult } from "./local-executor";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { RunComponentsOptions, RunComponentsResult } from "../components/cli-support";

/**
 * How a run ended, or that it has not. `gated` is the state a run reaches when
 * a gate has no recorded resolution — a fact, not a wait (#2119 makes the local
 * executor produce it; today only a hosting runtime can).
 */
export type OpRunState = "running" | "completed" | "failed" | "gated" | "cancelled";

/**
 * A run's current state, as every runtime reports it.
 *
 * `records` and `result` are populated by a runtime that has the executor's
 * own step records to hand (the local one does); a runtime that only knows the
 * coarse state omits them rather than inventing them.
 */
// #2118 owns the ledger-backed shape; reconcile at merge
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

/** One entry in a run history — what `chant run log <op>` prints a row per. */
// #2118 owns the ledger-backed shape; reconcile at merge
export interface OpRunRecord {
  op: string;
  runId: string;
  state: OpRunState;
  startedAt: string;
  endedAt?: string;
}

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
