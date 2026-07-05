/**
 * The azure lexicon's ownership tag convention. Azure tag keys forbid `/`, so
 * chant's markers use a hyphenated `chant-<name>` form (distinct from the
 * label-based convention core keeps for k8s/gcp, and from AWS's `chant:<name>`).
 * Core owns the generic stamp/detect logic (@intentius/chant/ownership); this is
 * the azure-specific key naming it stamps.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** Azure tag keys for chant's ownership markers. */
export const AZURE_TAG_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant-managed-by",
  stack: "chant-stack",
  env: "chant-env",
};
