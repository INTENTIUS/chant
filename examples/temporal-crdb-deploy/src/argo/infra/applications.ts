// Infra-layer Argo Applications — reconcile the Config Connector resources that
// build the regional GKE clusters. All target the management cluster (in-cluster),
// where Config Connector runs.
//
// Replaces the workflow's old applySharedInfra + applyRegionalInfra(×3)
// activities: the workflow now just applies these once and waits for Argo.

import { ArgoAppFor, ArgoAppSetForRegions } from "@intentius/chant-lexicon-k8s";
import { argo } from "../config";

// Shared infra (VPC, DNS, KMS, GCS, IAM) — one Application.
export const sharedInfra = ArgoAppFor("shared-infra", {
  repo: argo.repo,
  path: "dist/shared-infra",
  targetRevision: argo.revision,
  destination: { server: argo.inClusterServer, namespace: argo.ccNamespace },
});

// Regional infra (per-region GKE cluster + DNS zone + GSAs) — one ApplicationSet
// generating east-infra / central-infra / west-infra, all in-cluster.
export const regionalInfra = ArgoAppSetForRegions(
  [...argo.regions],
  (region) => ({
    server: argo.inClusterServer,
    namespace: argo.ccNamespace,
    path: `dist/${region}-infra`,
  }),
  { name: "infra", repo: argo.repo, targetRevision: argo.revision },
);
