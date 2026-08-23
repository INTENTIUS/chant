// Argo CD layer configuration.
//
// Argo runs on the management cluster. It reconciles two kinds of thing:
//   • infra — the Config Connector resources (GKE clusters, DNS, IAM) that the
//     mgmt cluster applies to GCP. Target: in-cluster (the mgmt cluster).
//   • workload — the per-region CockroachDB manifests + ESO. Target: each
//     regional workload cluster, registered with Argo via a cluster Secret.
//
// The built manifests are committed to the argoRepo parameter (ARGO_REPO);
// Argo syncs them from there.

import { params } from "@intentius/chant/params";
import { GCP_PROJECT_ID, CRDB_DOMAIN } from "../shared/config";

// Workload-cluster API server endpoints, declared as optional build
// parameters (GKE_ENDPOINT_EAST / _CENTRAL / _WEST). Unset reads as undefined.
const GKE_ENDPOINTS: Record<string, string | undefined> = {
  east: params.gkeEndpointEast as string | undefined,
  central: params.gkeEndpointCentral as string | undefined,
  west: params.gkeEndpointWest as string | undefined,
};

export const argo = {
  // Git source Argo watches (push your `npm run build` output here).
  repo: (params.argoRepo as string | undefined) ?? `https://github.com/your-org/crdb-${GCP_PROJECT_ID}`,
  revision: params.argoRevision as string,

  // The mgmt cluster Argo deploys infra into (in-cluster). Config Connector
  // watches this namespace.
  inClusterServer: "https://kubernetes.default.svc",
  ccNamespace: params.ccNamespace as string,

  // Regions and their workload-cluster API server endpoints. These exist only
  // after SYNC_INFRA creates the clusters; the workflow applies the workload
  // Argo manifests after that.
  regions: ["east", "central", "west"] as const,
  clusterServer: (region: string): string =>
    GKE_ENDPOINTS[region] ?? `https://${region}.gke.${CRDB_DOMAIN}`,
  namespace: (region: string): string => `crdb-${region}`,
} as const;
