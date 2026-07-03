/**
 * Shared helper for building typed capability stubs.
 *
 * A stub is fully typed (`kind`, `In`, `Out`) so compositions can wire
 * output -> input and lint can check the graph, but `run`/`rollback` throw
 * `CapabilityNotImplementedError` — no cloud calls, no side effects. Cloud
 * implementations land in a later phase (epic #551).
 */

import type { Capability } from "../capability";
import { CapabilityNotImplementedError } from "../capability";

/**
 * Build a stub `Capability<In, Out>` for `kind`. `supportsRollback` also
 * attaches a `rollback` that throws the same error, so compositions can
 * already reference `rollback` in typed code ahead of the real implementation.
 */
export function stubCapability<In, Out>(
  kind: string,
  opts?: { rollback?: boolean },
): Capability<In, Out> {
  const capability: Capability<In, Out> = {
    kind,
    async run(): Promise<Out> {
      throw new CapabilityNotImplementedError(kind);
    },
  };
  if (opts?.rollback) {
    capability.rollback = async (): Promise<void> => {
      throw new CapabilityNotImplementedError(kind);
    };
  }
  return capability;
}
