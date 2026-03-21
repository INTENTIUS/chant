// Local k3d RayCluster — validates KubeRay lifecycle without GCP dependencies.
//
// Emits the same resource types as the production config (ServiceAccount,
// NetworkPolicy, PDB, RayCluster CR) with local-friendly values:
//   - DockerHub image instead of Artifact Registry
//   - 1 head + 1 CPU worker (laptop-sized)
//   - No GPU worker group
//   - No shared storage (Filestore not available locally)
//   - No GCS spillover bucket (GCS not available locally)
//   - No Workload Identity annotation (no GCP SA)
//
// What this validates:
//   - RayCluster CR syntax is accepted by the KubeRay operator
//   - Workers join the head (ServiceAccount, RBAC, NetworkPolicy are correct)
//   - ray.cluster_resources() shows the expected CPUs
//
// What it does NOT validate:
//   - NetworkPolicy enforcement (k3s/flannel does not enforce NetworkPolicy)
//   - GPU scheduling, ReadWriteMany storage, GCS spillover, Workload Identity

import { RayCluster } from "@intentius/chant-lexicon-k8s";
import { localConfig } from "./config";

export const {
  serviceAccount,
  networkPolicy,
  pdb,
  rayCluster,
} = RayCluster({
  name: "ray",
  namespace: localConfig.namespace,
  cluster: {
    image: localConfig.rayImage,
    head: {
      resources: { cpu: "1", memory: "2Gi" },
      shmSize: "1Gi",
    },
    workerGroups: [
      {
        groupName: "cpu",
        replicas: 1,
        minReplicas: 1,
        maxReplicas: 1,
        resources: { cpu: "1", memory: "2Gi" },
        idleTimeoutSeconds: 60,
      },
    ],
  },
  // enableAutoscaler omitted — no ClusterRole needed for single-worker smoke test
  // sharedStorage omitted — Filestore not available locally
  // spilloverBucket omitted — GCS not available locally
  // exposeDashboard omitted — use kubectl port-forward if needed
});
