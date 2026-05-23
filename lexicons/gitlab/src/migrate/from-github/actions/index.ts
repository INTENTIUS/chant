/**
 * Action mapping registry — public surface.
 *
 * Tier 1/2/3 mappings register themselves into the default registry on import.
 */

export type {
  ActionMapping,
  ActionMapCtx,
  ActionMappedResult,
  ActionMappingRegistry,
} from "./registry";
export { createRegistry, getDefaultRegistry, lookupAction, setDefaultRegistry } from "./registry";

// Tier mappings register themselves on import (added in #87 and #88).
// For now, importing this module is a no-op beyond exposing the types.
