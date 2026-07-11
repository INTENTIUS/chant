/**
 * The fly lexicon's ownership convention (#743, decision D2), declared here so
 * core carries no fly-specific branch — the #686 seam: each lexicon owns its key
 * names; core keeps only the generic stamp/detect logic
 * (@intentius/chant/ownership), the same way aws declares `AWS_TAG_OWNERSHIP_KEYS`
 * and azure `AZURE_TAG_OWNERSHIP_KEYS`.
 *
 * The convention is two-tier, because flaps resources differ in what they can
 * carry:
 *
 *   1. Primary marker — machine `config.metadata`. Machines carry a flat
 *      `Record<string, string>`, so chant stamps `managed-by: chant` (+ stack/env)
 *      there. This is the k8s-label / AWS-tag analogue and the basis for
 *      owned-only machine prune (a metadata filter — a foreign machine survives).
 *      The serializer stamps it (see serializer.ts); the applier reads it via
 *      `isChantOwned` → core `hasOwnershipMarker(..., FLY_METADATA_OWNERSHIP_KEYS)`.
 *
 *   2. Secondary boundary — the app. Volumes, secrets, certs, and IPs carry no
 *      arbitrary metadata, so for them the Fly app is the ownership boundary
 *      (like a CloudFormation stack): chant owns the app's declared-type
 *      resources and prunes owned orphans within app scope. See the app-scoped
 *      prune block in op/activities/fly-apply.ts for the limitation this leaves.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** Machine `config.metadata` keys for chant's ownership markers (tier 1, D2). */
export const FLY_METADATA_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};
