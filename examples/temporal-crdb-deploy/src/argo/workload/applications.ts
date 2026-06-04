// Workload-layer Argo manifests — applied after the regional GKE clusters exist.
//
//   • registerArgoCluster — teach the mgmt-cluster Argo about each workload
//     cluster (ARGO003 resolves Application destinations against these).
//   • ESO (Helm) — one Application per cluster (replaces installESO ×3).
//   • CockroachDB — one ApplicationSet generating east-crdb/central-crdb/west-crdb,
//     each targeting its workload cluster (replaces applyK8sManifests ×3 AND
//     waitForStatefulSets ×3 — Argo Health=Healthy subsumes the rollout wait).

import { Application, ArgoAppSetForRegions, registerArgoCluster } from "@intentius/chant-lexicon-k8s";
import { argo } from "../config";

const ESO_CHART_VERSION = "0.10.4";

// ── Register the three workload clusters with Argo ──────────────────────────
export const eastCluster = registerArgoCluster({ name: "east", server: argo.clusterServer("east") });
export const centralCluster = registerArgoCluster({ name: "central", server: argo.clusterServer("central") });
export const westCluster = registerArgoCluster({ name: "west", server: argo.clusterServer("west") });

// ── External Secrets Operator per cluster (Helm source) ─────────────────────
// ArgoAppFor is for git sources; a Helm chart source uses the raw Application.
function esoApp(region: string) {
  return new Application({
    metadata: {
      name: `${region}-eso`,
      namespace: "argocd",
      labels: { "app.kubernetes.io/name": `${region}-eso`, "app.kubernetes.io/managed-by": "chant" },
    },
    spec: {
      project: "default",
      source: {
        repoURL: "https://charts.external-secrets.io",
        chart: "external-secrets",
        targetRevision: ESO_CHART_VERSION,
        helm: { parameters: [{ name: "installCRDs", value: "true" }] },
      },
      destination: { name: region, namespace: "kube-system" },
      syncPolicy: {
        automated: { prune: false, selfHeal: true },
        syncOptions: ["CreateNamespace=true"],
      },
    },
  });
}

export const eastEso = esoApp("east");
export const centralEso = esoApp("central");
export const westEso = esoApp("west");

// ── CockroachDB workload manifests, one Application per region ───────────────
export const crdb = ArgoAppSetForRegions(
  [...argo.regions],
  (region) => ({
    name: region, // target the registered workload cluster by name
    namespace: argo.namespace(region),
    path: `dist/${region}-k8s`,
  }),
  { name: "crdb", repo: argo.repo, project: "default", targetRevision: argo.revision },
);
