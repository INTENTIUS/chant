// Local k3d configuration for the ray-kuberay-gke smoke test.
// Substitutes GCP-specific dependencies with local equivalents:
//   - DockerHub rayproject/ray image instead of Artifact Registry
//   - k3s local-path StorageClass instead of Filestore
//   - No GCS spillover, no Workload Identity

export const localConfig = {
  namespace: "ray-system",

  // DockerHub image — no Artifact Registry needed for local dev.
  // Override with RAY_IMAGE env var to test a custom image loaded via
  // `k3d image import` before running the smoke test.
  rayImage: process.env.RAY_IMAGE ?? "rayproject/ray:2.40.0",

  // k3s ships a local-path provisioner (ReadWriteOnce).
  // Filestore (ReadWriteMany) is not available locally; shared storage
  // is omitted from the local RayCluster config.
  storageClass: "local-path",
};
