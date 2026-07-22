/**
 * Terraform-type → native-spec tier map for the carve-out advisor (#214 T3).
 *
 * The AWS entries are derived from the single AWS carve-out table
 * (`aws-resources.ts`), so the advisor ranks exactly the AWS types `carve emit`
 * can produce — no advise↔emit cliff. Non-AWS entries (e.g. `kubernetes_manifest`)
 * are listed here directly; emit for those is a separate target.
 *
 *   tier 1 — a clean 1:1 native resource
 *   tier 2 — maps, but with reshaping
 *   tier 3 — a hard/partial map
 *   null   — no known native mapping (unsupported provider/type) → score 0
 */

import { AWS_CARVE_TYPES } from "./aws-resources";

export interface TierInfo {
  tier: 1 | 2 | 3;
  /** The native spec type a carve would target, for the report. */
  mapsTo: string;
}

/** TF resource type → native tier. Absent = unsupported (score 0). */
export const TIER_MAP: Record<string, TierInfo> = {
  // AWS: derived from the carve-out table so advise and emit stay in lockstep.
  ...Object.fromEntries(AWS_CARVE_TYPES.map((t) => [t.tfType, { tier: t.tier, mapsTo: t.nativeType }])),
  // Kubernetes — near-1:1 manifest. Ranked by advise; emit support is a separate target.
  kubernetes_manifest: { tier: 1, mapsTo: "k8s:manifest" },
};

/**
 * TF "sub-resource" types that inline into a parent resource rather than
 * standing alone (TF splits config the native spec keeps in one resource).
 * A sub-resource that shares its parent's name is folded into the parent's
 * carve set: it is not ranked on its own, and its edge to the parent does not
 * count as inbound boundary work — inlining it is free.
 *
 * Maps sub-resource TF type → parent TF type.
 */
export const FOLDS_INTO: Record<string, string> = {
  aws_s3_bucket_versioning: "aws_s3_bucket",
  aws_s3_bucket_acl: "aws_s3_bucket",
  aws_s3_bucket_policy: "aws_s3_bucket",
  aws_s3_bucket_public_access_block: "aws_s3_bucket",
  aws_s3_bucket_server_side_encryption_configuration: "aws_s3_bucket",
  aws_s3_bucket_lifecycle_configuration: "aws_s3_bucket",
};

/**
 * The HCL attribute carrying a resource's physical name, per type — derived
 * from the AWS carve-out table. Used for the graph's identity and the
 * live-import hint. Absent → fall back to the TF logical name.
 */
export const IDENTITY_ATTR: Record<string, string> = Object.fromEntries(
  AWS_CARVE_TYPES.filter((t) => t.identityAttr).map((t) => [t.tfType, t.identityAttr!]),
);

export function resolveTier(tfType: string): TierInfo | null {
  return TIER_MAP[tfType] ?? null;
}
