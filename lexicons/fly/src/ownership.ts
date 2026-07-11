/**
 * The fly lexicon's ownership marker convention. Fly machines carry ownership
 * in their `config.metadata` map (a flat `Record<string, string>`), not in
 * cloud tags or k8s labels. Decision D2 fixes the managed-by key as the bare
 * `managed-by`, so chant's marker uses that key with the stack/env keys
 * namespaced alongside it. Core owns the generic stamp/detect logic
 * (@intentius/chant/ownership); this is the fly-specific key naming it stamps.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** Machine `config.metadata` keys for chant's ownership markers (D2). */
export const FLY_METADATA_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};
