/**
 * chant #1045 (Phase 1) — the JSON wire format for a discovered, named,
 * ref-resolved entity set, plus (below) the standalone `discover()` +
 * encode entry point.
 *
 * The codec itself — {@link WireValue}, {@link EntitySetWire},
 * {@link encodeEntitySet}, {@link decodeEntitySet}, and friends — lives in
 * `./entity-wire-codec.ts` (chant #1045 Phase 2 split this out) and is
 * re-exported here unchanged. That file has NO dependency on `discover()` (or
 * anything that pulls in the `typescript` compiler package), which matters
 * because chant #1045 Phase 2's sandboxed child bundles JUST the codec —
 * bundling this file, `discoverEntitySetJson` and all, would drag `discover`
 * → `fold-import` → `typescript` (a multi-megabyte CJS package that doesn't
 * survive ESM bundling on its own) into a driver that only ever needs to
 * encode, never to discover. See `./sandbox/driver.ts`.
 */

export type {
  WireValue,
  WireDeclarableEntity,
  WireLexiconOutputEntity,
  WireEntity,
  EntitySetWire,
} from "./entity-wire-codec";
export { encodeEntitySet, decodeEntitySet } from "./entity-wire-codec";

import type { FoldDecision } from "./index";
import { discover, type DiscoveryOptions } from "./index";
import { encodeEntitySet, type EntitySetWire } from "./entity-wire-codec";

// ─────────────────────────────────────────────────────────────────────────
// Standalone entry point (chant#1045 Phase 1, ask #2): "run these files,
// produce named ref-resolved entity specs" as pure JSON.
// ─────────────────────────────────────────────────────────────────────────

/** A discovery run's full result as pure JSON — {@link encodeEntitySet} plus the already-JSON-safe rest of {@link DiscoveryResult} (`./index.ts`). */
export interface DiscoveredEntitiesJson {
  entitySet: EntitySetWire;
  sourceFiles: string[];
  /** `DiscoveryError.toJSON()` output — see `../errors.ts`. */
  errors: Array<{ name: string; file: string; message: string; type: string }>;
  foldDecisions: FoldDecision[];
}

/**
 * Run discovery over `path` — scanning files, importing/folding modules,
 * naming entities, and resolving `AttrRef`s (all unchanged, reusing
 * `discover()` as-is) — and return the result as pure JSON via
 * {@link encodeEntitySet}. This is the boundary chant#1045 Phase 2 moved into
 * a sandboxed child process for the run-fallback subset — see
 * `./sandbox/run.ts` — Phase 1 only proved the data can cross it losslessly
 * (see the fold-vs-JSON differential in `examples/`).
 *
 * Reuses `discover()` unchanged, so the fold/run-fallback split and the
 * `planFoldTaint` identity-taint invariant (`./fold-import.ts`) are exactly
 * what they are today — this function only serializes whatever `discover()`
 * already decided to produce.
 */
export async function discoverEntitySetJson(path: string, options?: DiscoveryOptions): Promise<DiscoveredEntitiesJson> {
  const result = await discover(path, options);
  return {
    entitySet: encodeEntitySet(result.entities),
    sourceFiles: result.sourceFiles,
    errors: result.errors.map((e) => e.toJSON()),
    foldDecisions: result.foldDecisions,
  };
}
