/**
 * The aws lexicon's ownership tag convention. AWS tag keys allow `:`, so
 * chant's markers use the `chant:<name>` form (distinct from the label-based
 * convention core keeps for k8s/gcp). Core owns the generic stamp/detect logic
 * (@intentius/chant/ownership); this is the aws-specific key naming it stamps.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** AWS tag keys for chant's ownership markers. */
export const AWS_TAG_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant:managed-by",
  stack: "chant:stack",
  env: "chant:env",
};
