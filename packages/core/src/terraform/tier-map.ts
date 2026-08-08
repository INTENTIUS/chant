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

/**
 * Kubernetes provider types with a native k8s-lexicon target. `kubernetes_manifest`
 * IS the manifest (tier 1). The typed provider resources (`kubernetes_deployment`,
 * ...) reshape their HCL schema back into a manifest, so they rank tier 2; the
 * common `_v1` aliases share their base type's entry.
 */
const K8S_TIER_BASE: Record<string, TierInfo> = {
  kubernetes_manifest: { tier: 1, mapsTo: "k8s:manifest" },
  kubernetes_namespace: { tier: 2, mapsTo: "k8s:Namespace" },
  kubernetes_config_map: { tier: 2, mapsTo: "k8s:ConfigMap" },
  kubernetes_secret: { tier: 2, mapsTo: "k8s:Secret" },
  kubernetes_service: { tier: 2, mapsTo: "k8s:Service" },
  kubernetes_service_account: { tier: 2, mapsTo: "k8s:ServiceAccount" },
  kubernetes_deployment: { tier: 2, mapsTo: "k8s:Deployment" },
  kubernetes_stateful_set: { tier: 2, mapsTo: "k8s:StatefulSet" },
  kubernetes_daemon_set: { tier: 2, mapsTo: "k8s:DaemonSet" },
  kubernetes_job: { tier: 2, mapsTo: "k8s:Job" },
  kubernetes_cron_job: { tier: 2, mapsTo: "k8s:CronJob" },
  kubernetes_ingress: { tier: 2, mapsTo: "k8s:Ingress" },
  kubernetes_network_policy: { tier: 2, mapsTo: "k8s:NetworkPolicy" },
  kubernetes_persistent_volume_claim: { tier: 2, mapsTo: "k8s:PersistentVolumeClaim" },
  kubernetes_role: { tier: 2, mapsTo: "k8s:Role" },
  kubernetes_role_binding: { tier: 2, mapsTo: "k8s:RoleBinding" },
  kubernetes_cluster_role: { tier: 2, mapsTo: "k8s:ClusterRole" },
  kubernetes_cluster_role_binding: { tier: 2, mapsTo: "k8s:ClusterRoleBinding" },
  kubernetes_resource_quota: { tier: 2, mapsTo: "k8s:ResourceQuota" },
  kubernetes_limit_range: { tier: 2, mapsTo: "k8s:LimitRange" },
  kubernetes_priority_class: { tier: 2, mapsTo: "k8s:PriorityClass" },
  kubernetes_pod_disruption_budget: { tier: 2, mapsTo: "k8s:PodDisruptionBudget" },
  kubernetes_horizontal_pod_autoscaler: { tier: 2, mapsTo: "k8s:HorizontalPodAutoscaler" },
};

const K8S_TIER: Record<string, TierInfo> = Object.fromEntries(
  Object.entries(K8S_TIER_BASE).flatMap(([type, info]) =>
    type === "kubernetes_manifest" ? [[type, info]] : [[type, info], [`${type}_v1`, info]],
  ),
);
// The one provider type whose current alias is _v2, not _v1.
K8S_TIER.kubernetes_horizontal_pod_autoscaler_v2 = K8S_TIER_BASE.kubernetes_horizontal_pod_autoscaler;

/** TF resource type → native tier. Absent = unsupported (score 0). */
export const TIER_MAP: Record<string, TierInfo> = {
  // AWS: derived from the carve-out table so advise and emit stay in lockstep.
  ...Object.fromEntries(AWS_CARVE_TYPES.map((t) => [t.tfType, { tier: t.tier, mapsTo: t.nativeType }])),
  // Kubernetes — ranked by advise; emit support is a separate target.
  ...K8S_TIER,
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
  aws_s3_bucket_website_configuration: "aws_s3_bucket",
  aws_s3_bucket_cors_configuration: "aws_s3_bucket",
  aws_s3_bucket_logging: "aws_s3_bucket",
  aws_s3_bucket_ownership_controls: "aws_s3_bucket",
  aws_s3_bucket_notification: "aws_s3_bucket",
  aws_s3_bucket_accelerate_configuration: "aws_s3_bucket",
  aws_s3_bucket_request_payment_configuration: "aws_s3_bucket",
  aws_s3_bucket_intelligent_tiering_configuration: "aws_s3_bucket",
  aws_ecr_lifecycle_policy: "aws_ecr_repository",
  aws_ecr_repository_policy: "aws_ecr_repository",
};

/**
 * The HCL attribute carrying a resource's physical name, per type — AWS entries
 * derived from the carve-out table, non-AWS listed directly. A dotted entry is
 * a path into nested blocks (`manifest.metadata.name`). Used for the graph's
 * identity and the live-import hint. Absent → fall back to the TF logical name.
 */
export const IDENTITY_ATTR: Record<string, string> = {
  ...Object.fromEntries(AWS_CARVE_TYPES.filter((t) => t.identityAttr).map((t) => [t.tfType, t.identityAttr!])),
  kubernetes_manifest: "manifest.metadata.name",
};

export function resolveTier(tfType: string): TierInfo | null {
  return TIER_MAP[tfType] ?? null;
}
