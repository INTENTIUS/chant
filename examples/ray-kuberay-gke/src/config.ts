// Shared configuration for the ray-kuberay-gke example.
// In production, populate env vars from the infra outputs:
//   gcloud container clusters describe ray-gke --region us-central1 --format json
//   gcloud filestore instances describe ray-filestore --zone us-central1-a --format json

export const config = {
  projectId: process.env.GCP_PROJECT_ID ?? "my-project",
  region: process.env.GCP_REGION ?? "us-central1",

  // GKE
  clusterName: process.env.GKE_CLUSTER_NAME ?? "ray-gke",
  vpcName: process.env.VPC_NAME ?? "ray-vpc",
  subnetName: process.env.SUBNET_NAME ?? "ray-subnet",

  // Filestore (created in infra layer)
  filestoreName: process.env.FILESTORE_NAME ?? "ray-filestore",
  filestoreStorageClass: "ray-filestore",

  // GCS spillover bucket
  spilloverBucketName: process.env.SPILLOVER_BUCKET ?? "ray-spill",

  // Artifact Registry
  registryName: process.env.REGISTRY_NAME ?? "ray-images",

  // IAM — GCP service account for head pods (Workload Identity)
  rayGsaEmail: process.env.RAY_GSA_EMAIL
    ?? "ray-workload@my-project.iam.gserviceaccount.com",

  // Ray namespace and image
  namespace: "ray-system",
  rayImage: process.env.RAY_IMAGE
    ?? "us-central1-docker.pkg.dev/my-project/ray-images/ray:2.54.0",

  // Grafana host for Ray dashboard Metrics tab (RAY_GRAFANA_HOST).
  // Points at kube-prometheus-stack Grafana installed via `just install-monitoring`.
  grafanaHost: process.env.RAY_GRAFANA_HOST
    ?? "http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local",
};
