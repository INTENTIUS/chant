// Ray cluster — KubeRay RayCluster CR + surrounding K8s infra.
//
// Emits:
//   - ServiceAccount ray-head (head pod identity)
//   - ClusterRole/CRB ray-autoscaler (pod CRUD for in-tree autoscaler)
//   - NetworkPolicy ray (podSelector-only, avoids GKE pod CIDR mismatch)
//   - PodDisruptionBudget ray-head (minAvailable: 1)
//   - PersistentVolumeClaim ray-shared (ReadWriteMany, binds to static NFS PV from storage.ts)
//   - RayCluster ray (KubeRay CR with production defaults)
//
// Production defaults encoded in composite:
//   - preStop: ray stop + terminationGracePeriodSeconds: 120 on all pods
//   - idleTimeoutSeconds: 60 (CPU workers), 300 (GPU workers)
//   - num-cpus derived from resources.cpu (prevents autoscaler over-commit)
//   - RAY_object_spilling_config → GCS bucket (prevents head OOM on large objects)
//   - shmSize: "4Gi" on head (PyTorch tensor sharing via /dev/shm)
//   - GPU workers get nvidia.com/gpu toleration for the GPU tainted node pool

import { RayCluster } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// GKE Workload Identity annotation binds the K8s ServiceAccount to the GCP SA.
// The head pod inherits this identity and can access GCS (spillover bucket).
const WI_ANNOTATION = "iam.gke.io/gcp-service-account";

export const {
  serviceAccount,
  clusterRole,
  clusterRoleBinding,
  networkPolicy,
  pdb,
  pvc,
  rayCluster,
} = RayCluster({
  name: "ray",
  namespace: config.namespace,
  cluster: {
    // Use Artifact Registry image — pre-built for production.
    // Avoid pip installs via runtimeEnv: each worker restart re-installs,
    // adding minutes to cold start at scale. Pre-build images instead.
    image: config.rayImage,

    head: {
      resources: { cpu: "2", memory: "8Gi" },
      shmSize: "4Gi",    // Larger /dev/shm for PyTorch multi-process tensor sharing
      // Enable the Ray dashboard Metrics tab by pointing at the Grafana service.
      // Install monitoring first: `just install-monitoring`
      env: [{ name: "RAY_GRAFANA_HOST", value: config.grafanaHost }],
    },

    workerGroups: [
      {
        groupName: "cpu",
        replicas: 2,
        minReplicas: 1,
        maxReplicas: 8,
        resources: { cpu: "2", memory: "4Gi" },
        idleTimeoutSeconds: 60,
      },
      // GPU worker group — scales to zero when no GPU jobs are running.
      // Requires the GPU node pool created in the infra layer.
      {
        groupName: "gpu",
        replicas: 0,
        minReplicas: 0,
        maxReplicas: 4,
        resources: { cpu: "4", memory: "16Gi", gpu: 1 },
        gpuTolerations: true,
        idleTimeoutSeconds: 300,   // Higher threshold — amortize GPU init overhead
      },
    ],
  },

  // Shared training data volume (Filestore BASIC_HDD via static NFS PV, ReadWriteMany).
  // All pods mount this at /mnt/ray-data for shared dataset access.
  // Without shared storage, workers re-download training data on reschedule.
  sharedStorage: {
    storageClass: config.filestoreStorageClass,
    size: "1Ti",
    mountPath: "/mnt/ray-data",
  },

  // In-tree autoscaler: scales worker replicas based on pending task demand.
  // Requires the ClusterRole/CRB emitted by this composite.
  enableAutoscaler: true,

  // GCS spillover: Ray spills large object store entries to GCS instead of OOM-ing.
  // Head pod needs GCS access (provided by Workload Identity via rayHeadSa).
  spilloverBucket: config.spilloverBucketName,

  // Dashboard accessible via: kubectl port-forward svc/ray-head-svc 8265:8265
  // Set exposeDashboard: true to emit a LoadBalancer Service (not recommended
  // for production without auth — dashboard has no built-in authentication).
  exposeDashboard: false,

  // Inject GKE Workload Identity annotation into the head ServiceAccount.
  // This binds K8s SA ray-system/ray-head → GCP SA ray-workload so the head
  // pod can impersonate the GCP SA and access GCS (spillover bucket).
  defaults: {
    serviceAccount: {
      metadata: {
        annotations: { [WI_ANNOTATION]: config.rayGsaEmail },
      },
    },
  },
});
