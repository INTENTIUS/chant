/**
 * The run an activity is part of (#2522).
 *
 * An activity is called as `fn(args, signal)`, which says nothing about the
 * run around it. An activity that deploys somewhere needs the environment the
 * run was asked for, one that appends a ledger record of its own needs the run
 * id to name the run that made it, and a step after a gate may need to know the
 * gate passed and who approved it.
 *
 * `runOpLocally` (`./local-executor.ts`) sets this for the whole run, and
 * {@link currentOpRun} reads it from inside an activity. It is backed by
 * `AsyncLocalStorage`, so it follows the activity through every `await` and is
 * `undefined` outside a run.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { StepRecord } from "./local-executor";

/** A gate this run has passed, with the approval that passed it. */
export interface PassedGate {
  gate: string;
  approval: NonNullable<StepRecord["approval"]>;
}

/** What an activity can read about the run it is in. */
export interface OpRunContext {
  /** The Op's name. */
  op: string;
  /** The run id the run ledger record carries. */
  runId: string;
  /** `--env`, as handed to `OpRuntimeProvider.start`. Absent when the run was started without one. */
  env?: string;
  /** Every gate this run has passed so far, in the order it passed them. */
  passedGates: PassedGate[];
}

const store = new AsyncLocalStorage<OpRunContext>();

/**
 * The run the calling activity is part of, or `undefined` outside a run.
 * `passedGates` is a copy taken at the time of the call.
 */
export function currentOpRun(): OpRunContext | undefined {
  const ctx = store.getStore();
  return ctx ? { ...ctx, passedGates: [...ctx.passedGates] } : undefined;
}

/** Run `fn` with `ctx` as the current run. The executor calls this. A runtime that calls activities itself can too. */
export function withOpRunContext<T>(ctx: OpRunContext, fn: () => T): T {
  return store.run(ctx, fn);
}
