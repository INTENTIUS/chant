/**
 * Action mapping registry — public surface.
 *
 * Tier 1 mappings auto-register into the default registry on import of
 * this module. Tier 2 and Tier 3 are added in #88.
 */

export type {
  ActionMapping,
  ActionMapCtx,
  ActionMappedResult,
  ActionMappingRegistry,
} from "./registry";
export { createRegistry, getDefaultRegistry, lookupAction, setDefaultRegistry } from "./registry";

import { registerTier1 } from "./tier-1";
import { getDefaultRegistry } from "./registry";

// Auto-register Tier 1 into the default registry the first time this
// module is imported.
registerTier1(getDefaultRegistry());

export { registerTier1 };
