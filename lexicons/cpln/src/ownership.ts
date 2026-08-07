/**
 * The cpln lexicon's ownership convention.
 *
 * Declared here rather than in core — the same seam aws (`chant:managed-by`),
 * azure and fly sit on. Core owns the generic stamp/detect logic; each lexicon
 * owns key names its provider will actually accept.
 *
 * Control Plane gives every kind a free-form `tags` map, which makes this the
 * cleanest ownership channel of any target chant supports: one uniform place on
 * all eight kinds, readable straight off a plain `GET`, with no per-kind
 * special case of the sort fly needs for volumes and certificates.
 *
 * Key naming. Tag keys accept a `/`, which Control Plane uses itself for its
 * reserved `cpln/…` keys (`cpln/relaxMemoryToCpuRatio`). A prefixed key is
 * therefore both idiomatic and safely namespaced against a future reserved key,
 * so these follow the same `chant.intentius.io/…` convention as the shared
 * label channel rather than inventing a flat spelling. The `cpln/` prefix is
 * Control Plane's own and is never written here.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** Tag keys carrying chant's ownership marker on every cpln resource. */
export const CPLN_TAG_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant.intentius.io/managed-by",
  stack: "chant.intentius.io/stack",
  env: "chant.intentius.io/env",
};
