/**
 * A step whose command stopped at a gate of its own (#2779).
 *
 * Some chant commands decide a gate themselves rather than through a `gate`
 * step: `chant workspace upgrade` stages its patch, records
 * `workspace-upgrade` / `<scope>` pending on the gate ledger, and exits 3.
 * An Op step that runs such a command stops its run at that gate by throwing
 * {@link GateWait} with the pending fact the command recorded. The executor
 * ends the run there with status `gated`, as it does at a pending `gate`
 * step: no later step runs, no `onFailure` phase runs, a work lease is
 * released `gated`, and the run ledger names the gate, with the op it is
 * recorded under when that isn't the run's own.
 *
 * Nothing waits. After `chant approve <op> <gate>` the next run runs the
 * command again, the command finds the approval, and the step goes on. A
 * local steward re-runs its own gated run on the first round after the
 * approval (`./operator.ts`).
 *
 * `shell()` throws it for an exit code named in `gatedExit`
 * (`./activities/shell.ts`); an activity of a lexicon can throw it too.
 */

import type { PendingGateRecord } from "../lifecycle/gate-ledger";

/** The marker {@link GateWait} carries, so a copy of core linked twice still recognises it. */
const GATE_WAIT = Symbol.for("chant.op.GateWait");

/**
 * Thrown by an activity whose command stopped at a gate. Not a failure: the
 * executor ends the run with status `gated` (see the module doc).
 */
export class GateWait extends Error {
  readonly [GATE_WAIT] = true;
  constructor(readonly pending: PendingGateRecord) {
    super(`stopped at gate ${pending.op} / ${pending.gate}: approve it with \`chant approve ${pending.op} ${pending.gate}\` and run again`);
    this.name = "GateWait";
  }
}

/** Is this a {@link GateWait}? Duck-typed on the shared symbol. */
export function isGateWait(err: unknown): err is GateWait {
  return !!err && typeof err === "object" && (err as Record<symbol, unknown>)[GATE_WAIT] === true && "pending" in err;
}

/**
 * `value` as a pending gate fact, or undefined when it isn't one: it needs
 * the `op`, `gate`, `timestamp` and `expiresAt` every pending line on the
 * gate ledger carries.
 */
export function asPendingGate(value: unknown): PendingGateRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  for (const key of ["op", "gate", "timestamp", "expiresAt"]) {
    if (typeof v[key] !== "string" || v[key] === "") return undefined;
  }
  return { ...(v as unknown as PendingGateRecord), version: 1, kind: "pending" };
}
