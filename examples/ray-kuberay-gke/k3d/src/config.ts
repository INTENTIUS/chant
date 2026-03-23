// Local k3d configuration for the ray-kuberay-gke smoke test.
// Substitutes GCP-specific dependencies with local equivalents:
//   - DockerHub rayproject/ray image instead of Artifact Registry
//   - k3s local-path StorageClass instead of Filestore
//   - No GCS spillover, no Workload Identity

export const localConfig = {
  namespace: "ray-system",

  // DockerHub image — no Artifact Registry needed for local dev.
  // Uses the same Ray version as the production config for job portability.
  // Selects the aarch64 variant on Apple Silicon to avoid QEMU emulation overhead.
  // Override with RAY_IMAGE env var to test a custom image loaded via
  // `k3d image import` before running the smoke test.
  rayImage: process.env.RAY_IMAGE
    ?? `rayproject/ray:2.54.0-py311${process.arch === "arm64" ? "-aarch64" : ""}`,

  // k3s ships a local-path provisioner (ReadWriteOnce).
  // Filestore (ReadWriteMany) is not available locally; shared storage
  // is omitted from the local RayCluster config.
  storageClass: "local-path",

  // Grafana host for Ray dashboard Metrics tab.
  // Same kube-prometheus-stack service name as production — install via `just local-monitoring`.
  grafanaHost: process.env.RAY_GRAFANA_HOST
    ?? "http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local",
};
