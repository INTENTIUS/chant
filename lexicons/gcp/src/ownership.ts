/**
 * GCP's ownership marker channels (#1446).
 *
 * The gcp lexicon marks ownership on **two different surfaces**, and they
 * legitimately use different key vocabularies:
 *
 * 1. **The Config Connector object** — what the serializer emits. Its
 *    `metadata.labels` are Kubernetes labels, so it uses core's shared
 *    `LABEL_OWNERSHIP_KEYS` (`app.kubernetes.io/managed-by`). That is the key
 *    `plugin.ts` registers as the lexicon's `ownershipChannel` and the one the
 *    read paths resolve through.
 *
 * 2. **The GCP resource itself** — what `gcpApply` PUTs to the REST API. GCP
 *    label keys may not contain `/` or `.`, so `app.kubernetes.io/managed-by`
 *    is not a legal key there. Hence {@link GCP_RESOURCE_OWNERSHIP_KEYS}.
 *
 * This is worth stating because the split looks like the bug #1446 found in the
 * azure applier, and is not. Azure's serializer and applier both write ARM tags
 * — one surface, and they had drifted onto two keys for no reason. Here the two
 * surfaces are real and each key is the only legal one for its target.
 *
 * What #1446 changes is that the applier's predicate resolves through core's
 * `hasOwnershipMarker` against a declared channel, rather than comparing a
 * string literal inline. The key does not move; the drift risk does.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/**
 * Ownership keys for labels on a live GCP resource — the surface `gcpApply`
 * writes and `pruneOrphans` reads.
 *
 * GCP label keys are lowercase alphanumerics, `-` and `_` only, so this is the
 * GCP-valid equivalent of core's label convention rather than that convention
 * itself.
 */
export const GCP_RESOURCE_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};
