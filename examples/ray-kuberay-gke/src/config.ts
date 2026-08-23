// Shared configuration for the ray-kuberay-gke example.
// Every per-deployment value is declared in ../chant.config.ts's buildParams.
// Supply with --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  projectId: params.projectId as string,
  region: params.region as string,

  // GKE
  clusterName: params.clusterName as string,
  vpcName: params.vpcName as string,
  // CC resource name for the subnet (VpcNetwork creates it as "${vpcName}-nodes").
  subnetName: params.subnetName as string,

  // Filestore (created in infra layer)
  filestoreName: params.filestoreName as string,
  filestoreStorageClass: "ray-filestore",
  // IP of the CC-managed Filestore instance (available after `just deploy-infra`).
  filestoreIp: params.filestoreIp as string,

  // GCS spillover bucket
  spilloverBucketName: params.spilloverBucketName as string,

  // Artifact Registry
  registryName: params.registryName as string,

  // IAM — GCP service account for head pods (Workload Identity)
  rayGsaEmail: params.rayGsaEmail as string,

  // Ray namespace and image
  namespace: "ray-system",
  rayImage: params.rayImage as string,

  // Grafana host for Ray dashboard Metrics tab (RAY_GRAFANA_HOST).
  // Points at kube-prometheus-stack Grafana installed via `just install-monitoring`.
  grafanaHost: params.grafanaHost as string,
};
