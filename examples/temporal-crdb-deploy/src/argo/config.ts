// Argo CD layer configuration.
//
// Argo runs on the management cluster. It reconciles two kinds of thing:
//   • infra — the Config Connector resources (GKE clusters, DNS, IAM) that the
//     mgmt cluster applies to GCP. Target: in-cluster (the mgmt cluster).
//   • workload — the per-region CockroachDB manifests + ESO. Target: each
//     regional workload cluster, registered with Argo via a cluster Secret.
//
// The built manifests are committed to ARGO_REPO; Argo syncs them from there.

import { GCP_PROJECT_ID, CRDB_DOMAIN } from "../shared/config";

export const argo = {
  // Git source Argo watches (push your `npm run build` output here).
  repo: process.env.ARGO_REPO ?? `https://github.com/your-org/crdb-${GCP_PROJECT_ID}`,
  revision: process.env.ARGO_REVISION ?? "HEAD",

  // The mgmt cluster Argo deploys infra into (in-cluster). Config Connector
  // watches this namespace.
  inClusterServer: "https://kubernetes.default.svc",
  ccNamespace: process.env.CC_NAMESPACE ?? "config-control",

  // Regions and their workload-cluster API server endpoints. These exist only
  // after SYNC_INFRA creates the clusters; the workflow applies the workload
  // Argo manifests after that.
  regions: ["east", "central", "west"] as const,
  clusterServer: (region: string): string =>
    process.env[`GKE_ENDPOINT_${region.toUpperCase()}`] ?? `https://${region}.gke.${CRDB_DOMAIN}`,
  namespace: (region: string): string => `crdb-${region}`,
} as const;
