/**
 * The Kubernetes carve provider (#2016) — advise-only for now.
 *
 * `kubernetes_manifest` IS the manifest (tier 1). The typed provider resources
 * (`kubernetes_deployment`, ...) reshape their HCL schema back into a manifest,
 * so they rank tier 2; the common `_v1` aliases share their base type's entry.
 *
 * It declares no `emitTypes` and no `adopt`, so `carve emit` refuses these types
 * on both paths with the same message — the honest refusal #2015 established.
 * Emit lands here when #999 does: an `emitTypes` list plus an `adopt` that
 * renders a manifest, no edit to `adopt-state.ts` or `carve-emit.ts`.
 */

import type { CarveProvider, TierInfo } from "../carve-provider";

const BASE_TIERS: Record<string, TierInfo> = {
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

const TIERS: Record<string, TierInfo> = Object.fromEntries(
  Object.entries(BASE_TIERS).flatMap(([type, info]) =>
    type === "kubernetes_manifest" ? [[type, info]] : [[type, info], [`${type}_v1`, info]],
  ),
);
// The one provider type whose current alias is _v2, not _v1.
TIERS.kubernetes_horizontal_pod_autoscaler_v2 = BASE_TIERS.kubernetes_horizontal_pod_autoscaler;

export const kubernetesCarveProvider: CarveProvider = {
  name: "kubernetes",
  tfTypePrefixes: ["kubernetes_"],
  lexicon: "k8s",
  tiers: TIERS,
  // A dotted path into nested blocks: the graph walks it for identity, and
  // `carve bridge` refuses the type because a data-source body cannot express it.
  identityAttrs: { kubernetes_manifest: "manifest.metadata.name" },
};
