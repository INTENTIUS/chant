/**
 * The starter capability registry — one `CapabilityRegistry` pre-seeded with
 * every verb in the starter set (epic #551, issue #554). All stubs; no cloud
 * calls except for the #557/#558 AWS leaves (real implementations).
 *
 * Phase 2 (#559) promotes this convention to a first-class plugin contract
 * (./capability-plugin.ts): the starter verb set now ships as
 * `starterCapabilityPlugin` (./starter-plugin.ts), and `createCapabilityRegistry`
 * below builds its registry from that plugin's `capabilities()` instead of
 * registering each verb inline. This is a pure refactor — same kinds, same
 * capability instances, same registration order — so every existing caller
 * (the driver, the pilots, ./registry.test.ts) is unaffected. New code
 * should prefer `buildCapabilityRegistry` (./capability-plugin-loader.ts),
 * which additionally supports loading third-party capability plugins on top
 * of this same starter set, the way lexicons are discovered today.
 */

import { CapabilityRegistry } from "./capability";
import { starterCapabilityPlugin, STARTER_VERB_FAMILIES } from "./starter-plugin";

/** Build a fresh `CapabilityRegistry` containing every starter-set verb stub. */
export function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const capability of starterCapabilityPlugin.capabilities()) {
    registry.register(capability);
  }
  return registry;
}

/**
 * Every `kind` in the starter verb set, grouped by family — useful for tests
 * and docs generation. Re-exported here (source of truth moved to
 * ./starter-plugin.ts to avoid a module cycle with `starterCapabilityPlugin`)
 * so every existing import of `STARTER_VERB_FAMILIES` from this module keeps
 * working unchanged.
 */
export { STARTER_VERB_FAMILIES };
