---
skill: chant-k8s-ray
description: KubeRay composites for distributed Ray clusters on Kubernetes — RayCluster, RayJob, RayService
user-invocable: true
---

# KubeRay Composites

Three composites cover the full KubeRay surface: persistent clusters, ephemeral batch jobs, and Ray Serve HTTP endpoints.

## Prerequisites

KubeRay operator must be installed before applying any Ray CRs:

```bash
kubectl apply -f https://github.com/ray-project/kuberay/releases/download/v1.3.0/kuberay-operator.yaml
kubectl -n kuberay-operator wait deploy/kuberay-operator --for=condition=Available --timeout=120s
```

## When to use which composite

| Composite | Use case |
|---|---|
| `RayCluster` | Interactive dev, long-lived infra, jobs submitted via CLI / Ray client |
| `RayJob` | Training pipelines, batch jobs — spins up → runs → tears down |
| `RayService` | Ray Serve HTTP endpoints with zero-downtime blue-green upgrades |

---

## RayCluster — persistent cluster

```typescript
import { RayCluster } from "@intentius/chant-lexicon-k8s";

export const {
  serviceAccount,
  clusterRole,          // only when enableAutoscaler: true
  clusterRoleBinding,   // only when enableAutoscaler: true
  networkPolicy,
  pdb,
  pvc,                  // only when sharedStorage is set
  dashboardService,     // only when exposeDashboard: true
  rayCluster,
} = RayCluster({
  name: "ray",
  namespace: "ray-system",
  cluster: {
    image: "us-central1-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
    head: {
      resources: { cpu: "2", memory: "8Gi" },
      shmSize: "4Gi",    // /dev/shm for PyTorch multi-process tensor sharing
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
      {
        groupName: "gpu",
        replicas: 0,
        minReplicas: 0,
        maxReplicas: 4,
        resources: { cpu: "4", memory: "16Gi", gpu: 1 },
        gpuTolerations: true,
        idleTimeoutSeconds: 300,   // higher — amortize GPU init overhead
      },
    ],
  },
  sharedStorage: {
    storageClass: "ray-filestore",
    size: "1Ti",
    mountPath: "/mnt/ray-data",   // mounted on all pods (head + all workers)
  },
  spilloverBucket: "ray-spill",         // GCS bucket for object store overflow
  enableAutoscaler: true,
  exposeDashboard: false,               // use kubectl port-forward 8265 in dev
});
```

**Key props:**

| Prop | Type | Description |
|---|---|---|
| `name` | `string` | Resource name prefix |
| `namespace` | `string` | Kubernetes namespace |
| `cluster.image` | `string` | Ray Docker image (pre-built recommended) |
| `cluster.head.resources` | `ResourceSpec` | CPU/memory for the head pod |
| `cluster.head.shmSize` | `string?` | Size of /dev/shm emptyDir (default: `"2Gi"`) |
| `cluster.workerGroups` | `WorkerGroupSpec[]` | One entry per worker group |
| `sharedStorage` | `object?` | PVC + volume mounts on all pods |
| `spilloverBucket` | `string?` | GCS bucket for Ray object store spillover |
| `enableAutoscaler` | `boolean?` | Emit ClusterRole/CRB for in-tree autoscaler |
| `exposeDashboard` | `boolean?` | Emit LoadBalancer Service for port 8265 |
| `labels` | `Record<string, string>?` | Extra labels on all resources |
| `defaults` | `object?` | Deep-merge overrides onto any generated resource |

---

## RayJob — ephemeral cluster per batch job

```typescript
import { RayJob } from "@intentius/chant-lexicon-k8s";

export const { serviceAccount, networkPolicy, pvc, rayJob } = RayJob({
  name: "train-job",
  namespace: "ray-system",
  entrypoint: "python train.py --epochs 10",
  cluster: {
    image: "us-central1-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
    head: { resources: { cpu: "2", memory: "8Gi" } },
    workerGroups: [
      { groupName: "cpu", replicas: 4, resources: { cpu: "4", memory: "16Gi" } },
    ],
  },
  shutdownAfterJobFinishes: true,    // default: true — cluster tears down after job
  ttlSecondsAfterFinished: 300,      // default: 300 — delay before RayJob CR is deleted
  runtimeEnvYAML: "pip:\n  - torch==2.3.0",
  spilloverBucket: "ray-spill",
});
```

**Key props:**

| Prop | Type | Description |
|---|---|---|
| `entrypoint` | `string` | Shell command to run as the Ray job |
| `runtimeEnvYAML` | `string?` | Ray runtime env YAML (pip packages, env vars, working_dir) |
| `shutdownAfterJobFinishes` | `boolean?` | Tear down cluster after job completes (default: `true`) |
| `ttlSecondsAfterFinished` | `number?` | Seconds before deleting the RayJob CR (default: `300`) |

All other props (`cluster`, `sharedStorage`, `spilloverBucket`, `enableAutoscaler`) work the same as `RayCluster`.

---

## RayService — persistent Ray Serve endpoint

```typescript
import { RayService } from "@intentius/chant-lexicon-k8s";

export const {
  serviceAccount, networkPolicy, pdb, pvc,
  serveService,   // LoadBalancer Service on port 8000
  rayService,
} = RayService({
  name: "inference",
  namespace: "ray-system",
  serveConfigV2: `
applications:
  - name: classifier
    import_path: app:deployment
    route_prefix: /
    deployments:
      - name: Classifier
        num_replicas: 2
        ray_actor_options:
          num_cpus: 1
`,
  cluster: {
    image: "us-central1-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
    head: { resources: { cpu: "2", memory: "8Gi" } },
    workerGroups: [
      { groupName: "serve", replicas: 2, minReplicas: 1, maxReplicas: 8,
        resources: { cpu: "4", memory: "16Gi" } },
    ],
  },
  enableAutoscaler: true,
});
// Access: kubectl port-forward svc/inference-serve-svc 8000:8000
```

`serveService` is always emitted — a LoadBalancer Service on port 8000. To expose it via Ingress, add an annotation via `defaults.serveService`.

---

## Shared types

```typescript
interface ResourceSpec {
  cpu: string;      // "2", "500m"
  memory: string;   // "4Gi", "512Mi"
  gpu?: number;     // adds nvidia.com/gpu resource limit
}

interface HeadGroupSpec {
  resources: ResourceSpec;
  shmSize?: string;                          // /dev/shm size, default "2Gi"
  rayStartParams?: Record<string, string>;   // extra ray start flags
  env?: Array<{ name: string; value: string }>;
}

interface WorkerGroupSpec {
  groupName: string;
  replicas: number;
  minReplicas?: number;
  maxReplicas?: number;
  resources: ResourceSpec;
  idleTimeoutSeconds?: number;               // default 60; use 300+ for GPU
  gpuTolerations?: boolean;                  // tolerate nvidia.com/gpu taint
  rayStartParams?: Record<string, string>;
  env?: Array<{ name: string; value: string }>;
}
```

---

## Production defaults (encoded in composites)

All three composites automatically apply these defaults — no manual configuration needed:

| Default | Why |
|---|---|
| `preStop: ["ray", "stop"]` + `terminationGracePeriodSeconds: 120` | Graceful drain on pod eviction; in-flight tasks complete rather than fail |
| `idleTimeoutSeconds: 60` (default) | Prevents stuck idle workers consuming resources |
| `--num-cpus` derived from `resources.cpu` | Prevents autoscaler over-commit; without this Ray reads host CPU count, not container limit |
| `RAY_object_spilling_config` env var | Routes large object spills to GCS; without this, large models or shuffled datasets OOM the head |
| `shmSize` dshm emptyDir | PyTorch tensor sharing via /dev/shm; default 2Gi, set 4Gi+ for multi-process training |
| `gpuTolerations: true` | Adds `nvidia.com/gpu: present: NoSchedule` toleration; required for GPU node pools with standard taints |

---

## NetworkPolicy strategy

The composites emit a `NetworkPolicy` using `podSelector` only for intra-cluster rules — no IP CIDR blocks for Ray traffic. This avoids the GKE secondary IP range mismatch problem: GKE allocates pod CIDRs from secondary ranges that differ from declared subnet CIDRs, so CIDR-based NetworkPolicy rules silently fail when pods move nodes.

GCS/HTTPS egress uses an ipBlock rule with RFC1918 ranges excluded — this allows Google APIs (storage.googleapis.com) while blocking internal lateral movement.

Ports covered: 6379 (GCS object store), 8265 (dashboard), 10001–10002 (Ray client), 8080 (metrics), 32768–60999 (ephemeral gRPC).

DNS egress (port 53 UDP/TCP) is always allowed — required for head service resolution.

---

## Troubleshooting

**Workers not joining the cluster**
Check the NetworkPolicy allows port 6379 from worker pods. The composite uses `ray.io/cluster-name: <name>` as the podSelector label — confirm this label is present on the pods (`kubectl get pods -n ray-system --show-labels`).

**Autoscaler not scaling up**
`enableAutoscaler: true` is required to emit the ClusterRole with pod CRUD permissions. Without it, the autoscaler controller cannot create or delete pods and will silently fail.

**GPU workers not scheduling**
Set `gpuTolerations: true` on the GPU worker group. Without the `nvidia.com/gpu: present: NoSchedule` toleration, pods won't schedule on GPU-tainted nodes. Also confirm the node pool taint key matches.

**Head OOM on large workloads**
Set `spilloverBucket` to a GCS bucket the head pod can write to. The head pod needs GCS access — use Workload Identity and bind the K8s ServiceAccount to a GCP SA with `roles/storage.objectAdmin` on the bucket. The composite injects `RAY_object_spilling_config` automatically when `spilloverBucket` is set.

**Pre-built images vs runtimeEnv pip installs**
Avoid `runtimeEnvYAML` pip installs in production. Each worker restart re-runs pip install, adding minutes to cold start at scale. Pre-build a Docker image with all dependencies baked in and push it to Artifact Registry.
