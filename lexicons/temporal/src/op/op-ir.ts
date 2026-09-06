/**
 * op.json IR — a shim over core's `packages/core/src/op/op-ir.ts`.
 *
 * The IR moved to core in #2118 (epic #2114): it restates `OpConfig`, and
 * `OpConfig` is core's, as is the `ACTIVITY_PROFILES` table it resolves each
 * step's `profile` against (#2117). What is still this lexicon's is its
 * registered activity contracts, bound here as the default so every existing
 * caller (`./serializer.ts`, `./op-ir.test.ts`) gets the same op.json it
 * always did without passing them explicitly.
 *
 * Epic C deletes this file along with the rest of the lexicon; until then it
 * is the same re-export shim `op/activities/index.ts` is.
 */
import {
  buildOpIR as coreBuildOpIR,
  serializeOpIR as coreSerializeOpIR,
  collectActivityContracts,
  type OpIR,
  type OpConfig,
  type ActivityContract,
} from "@intentius/chant/op";
import * as ownActivityContracts from "./activity-contracts";

export {
  OP_IR_FORMAT_VERSION,
  opConfigFromIR,
  type OpIR,
  type OpIRActivityStep,
  type OpIRGateStep,
  type OpIREffectStep,
  type OpIRStep,
  type OpIRPhase,
  type OpIRActivityContract,
} from "@intentius/chant/op";

/** This lexicon's own registered activity contracts (chant #1288 Stage 1). */
const OWN_CONTRACTS: Map<string, ActivityContract> = (() => {
  const map = new Map<string, ActivityContract>();
  collectActivityContracts(ownActivityContracts as Record<string, unknown>, map);
  return map;
})();

/** Build the op.json IR with this lexicon's contracts bound. */
export function buildOpIR(
  config: OpConfig,
  contractRegistry: ReadonlyMap<string, ActivityContract> = OWN_CONTRACTS,
): OpIR {
  return coreBuildOpIR(config, contractRegistry);
}

/** Serialize the op.json IR with this lexicon's contracts bound. */
export function serializeOpIR(
  config: OpConfig,
  contractRegistry: ReadonlyMap<string, ActivityContract> = OWN_CONTRACTS,
): string {
  return coreSerializeOpIR(config, contractRegistry);
}
