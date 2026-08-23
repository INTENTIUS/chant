import type { ChantConfig } from "@intentius/chant";

/**
 * Every per-deployment value is a build-time parameter, not a `process.env`
 * read in source. The `env` mapping keeps `set -a && source .env` working;
 * the read itself is declared, validated, and resolved once before any
 * project file loads, so the in-process and sandboxed builds see the same
 * values (chant #1728). `src/chant.config.json` is only a lint-scoping
 * fragment; the project-config walk skips it and lands here.
 *
 * In production, populate the env vars from the infra outputs:
 *   gcloud container clusters describe ray-gke --region us-central1 --format json
 *   gcloud filestore instances describe ray-filestore --zone us-central1-a --format json
 */
export default {
  lexicons: ["gcp", "k8s", "k3d"],
  buildParams: {
    projectId: { type: "string", default: "my-project", env: "GCP_PROJECT_ID" },
    region: { type: "string", default: "us-central1", env: "GCP_REGION" },

    // GKE
    clusterName: { type: "string", default: "ray-gke", env: "GKE_CLUSTER_NAME" },
    vpcName: { type: "string", default: "ray-vpc", env: "VPC_NAME" },
    subnetName: {
      type: "string",
      default: "ray-vpc-nodes",
      env: "SUBNET_NAME",
      description: "CC resource name for the subnet (VpcNetwork creates it as \"${vpcName}-nodes\")",
    },

    // Filestore (created in infra layer)
    filestoreName: { type: "string", default: "ray-filestore", env: "FILESTORE_NAME" },
    filestoreIp: {
      type: "string",
      default: "10.0.0.0",
      env: "FILESTORE_IP",
      description:
        "IP of the CC-managed Filestore instance (available after `just deploy-infra`): gcloud filestore instances describe ray-filestore --zone us-central1-a --format='value(networks[0].ipAddresses[0])'",
    },

    // GCS spillover bucket
    spilloverBucketName: { type: "string", default: "ray-spill", env: "SPILLOVER_BUCKET" },

    // Artifact Registry
    registryName: { type: "string", default: "ray-images", env: "REGISTRY_NAME" },

    // IAM — GCP service account for head pods (Workload Identity)
    rayGsaEmail: {
      type: "string",
      default: "ray-workload@my-project.iam.gserviceaccount.com",
      env: "RAY_GSA_EMAIL",
    },

    // Ray image
    rayImage: {
      type: "string",
      default: "us-central1-docker.pkg.dev/my-project/ray-images/ray:2.54.0",
      env: "RAY_IMAGE",
    },

    // Grafana host for Ray dashboard Metrics tab (RAY_GRAFANA_HOST).
    // Points at kube-prometheus-stack Grafana installed via `just install-monitoring`.
    grafanaHost: {
      type: "string",
      default: "http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local",
      env: "RAY_GRAFANA_HOST",
    },
  },
} satisfies ChantConfig;
