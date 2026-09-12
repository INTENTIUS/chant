/**
 * The gate step's name field, and the one-version bridge for the key it used
 * to carry (chant #2202).
 *
 * A gate is a fact on the gate ledger, not a channel: since #2119 nothing is
 * running and nothing is signalled, so the field that names a gate is called
 * `gate` — the same word `chant approve <op> <gate>` takes on the command
 * line. It was called `signalName` through 0.58.0.
 *
 * `signalName` is still read, on `GateStep`, on the component `Gate` step and
 * on the composites' gate options, and a build that sees only the old key
 * warns once. It goes away in 0.60.0: delete this module's
 * {@link DEPRECATED_GATE_KEY_WARNING}, {@link usesDeprecatedGateKey}, the
 * `signalName` branch of {@link gateName}, the optional `signalName` fields
 * that call it, and the schema's `oneOf` once that release is out, leaving
 * `gate` as the only key.
 */

import type { OpConfig, PhaseDefinition, StepDefinition } from "./types";

/**
 * The op name a `chant components fan-out` gate is recorded under (#2420).
 *
 * A fan-out is a command rather than an authored `*.op.ts`, so `chant approve`
 * has nothing to discover for this name and must not report that as a problem.
 * It lives here, next to the other thing that decides what a gate is called,
 * so both the command that records the pending fact and the command that
 * answers it read one constant instead of agreeing by hand.
 */
export const FAN_OUT_GATE_OP = "fan-out";

/** Either spelling of a gate step's name. `gate` since #2202; `signalName` through 0.59.0. */
export interface GateNamed {
  gate?: string;
  /** @deprecated Renamed to `gate` in #2202. Accepted through 0.59.0, removed in 0.60.0. */
  signalName?: string;
}

/**
 * The gate's name, from whichever key carries it. One place reads the old key,
 * so removing the bridge is a one-file edit rather than a sweep.
 */
export function gateName(step: GateNamed): string {
  return step.gate ?? step.signalName ?? "";
}

/** True when a step names its gate only with the deprecated key. */
export function usesDeprecatedGateKey(step: GateNamed): boolean {
  return step.gate === undefined && typeof step.signalName === "string";
}

/** What a build prints once when it finds a gate step still using the old key. */
export const DEPRECATED_GATE_KEY_WARNING =
  'Gate steps still using "signalName": the key is now "gate" (chant #2202). ' +
  '"signalName" is accepted through 0.59.0 and removed in 0.60.0.';

/**
 * True when any gate step in an Op's phases (main or `onFailure`, at any
 * nesting depth inside an `effect()`) names itself only with the deprecated
 * key. `chant build` calls this to warn once per build.
 */
export function opUsesDeprecatedGateKey(config: OpConfig): boolean {
  const inStep = (step: StepDefinition): boolean => {
    if (step.kind === "gate") return usesDeprecatedGateKey(step);
    if (step.kind === "effect") return step.steps.some(inStep);
    return false;
  };
  const inPhases = (phases: PhaseDefinition[] | undefined): boolean =>
    (phases ?? []).some((p) => p.steps.some(inStep));
  return inPhases(config.phases) || inPhases(config.onFailure);
}
