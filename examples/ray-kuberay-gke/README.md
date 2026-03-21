# Ray + KubeRay on GKE

A persistent Ray cluster on GKE backed by Filestore shared storage and GCS object-store spillover. Config Connector manages the GCP infrastructure; KubeRay manages the Ray cluster lifecycle.

## Agent walkthrough

The lexicon packages ship skills for agent-guided deployment. After `npm install`, your agent has access to:

| Skill | Package | Purpose |
|---|---|---|
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, apply, wait, troubleshoot |
| `chant-gcp-gke` | `@intentius/chant-lexicon-gcp` | GKE cluster, node pools, Workload Identity setup |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s manifest build and deployment |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | FilestoreStorageClass, WorkloadIdentityServiceAccount |
| `chant-k8s-ray` | `@intentius/chant-lexicon-k8s` | RayCluster/RayJob/RayService composites + NetworkPolicy patterns |

Paste this to Claude Code from the repo root:

```
Deploy the ray-kuberay-gke example.
The example is in examples/ray-kuberay-gke.
My GCP project is my-project-id. My region is us-central1.

Run npm install from the repo root first, then follow the phase-by-phase
instructions in examples/ray-kuberay-gke/README.md.
Set GCP_PROJECT_ID=my-project-id before running any commands.
```

The agent uses `chant-gcp` and `chant-gcp-gke` for the GCP infrastructure layer, then `chant-k8s` and `chant-k8s-ray` for the KubeRay cluster. The phase-by-phase breakdown below shows what it does under the hood.

## Local smoke test (no GCP required)

Validate the KubeRay lifecycle on your laptop before deploying to GKE. Runtime: ~3 minutes. No cloud credentials needed. Prerequisites: `k3d`, `kubectl`.

Paste this to Claude Code from the repo root:

```
Run the ray-kuberay-gke local smoke test.
The example is in examples/ray-kuberay-gke.

Run npm install from the repo root first, then follow the instructions
in examples/ray-kuberay-gke/README.md.
Prerequisites: k3d and kubectl must be installed.
```

Or manually:

```bash
cd examples/ray-kuberay-gke
just local-smoke
```

What it validates:
- KubeRay operator deploys and becomes Available
- `RayCluster` CR is accepted and reaches `state=ready`
- Head + 1 CPU worker join the cluster
- `ray.cluster_resources()` shows ≥ 2 CPUs available

What it does **not** validate: NetworkPolicy enforcement (k3s/flannel does not enforce it), GPU scheduling, ReadWriteMany shared storage, GCS spillover, Workload Identity. These are covered by the production GKE deploy and the unit tests in `examples/examples.test.ts`.

For iterative development without running the full smoke test each time:

```bash
just local-up      # create cluster, install operator, deploy
just local-wait    # wait for RayCluster ready
just local-test    # print ray.cluster_resources()
just local-down    # delete cluster
```

### Phase 0 — Prerequisites

- A GKE management cluster running Config Connector (needed to apply `config.yaml`). If you don't have one, see the `cockroachdb-multi-region-gke` example for a bootstrap script.
- `gcloud` CLI authenticated: `gcloud auth application-default login`
- Bun installed: [https://bun.sh](https://bun.sh)
- `npm install` run from the repo root

### Phase 1 — Build GCP manifests

```bash
export GCP_PROJECT_ID=my-project GCP_REGION=us-central1
cd examples/ray-kuberay-gke
npm run build:gcp
```

Runs `chant build src --lexicon gcp`, producing `config.yaml` — Config Connector resources for the GKE cluster, GPU node pool, Filestore ENTERPRISE instance, GCS spillover bucket, Artifact Registry, and IAM bindings.

### Phase 2 — Apply GCP infrastructure

```bash
kubectl apply -f config.yaml
```

Config Connector reconciles all GCP resources. Wait for the GKE cluster and Filestore instance to be ready (~10 minutes):

```bash
kubectl wait -f config.yaml --for=condition=Ready --timeout=600s
```

### Phase 3 — Get cluster credentials

```bash
just get-credentials
# or: gcloud container clusters get-credentials ray-gke --region us-central1 --project my-project
```

### Phase 4 — Install KubeRay operator

```bash
just install-operator
```

Applies the KubeRay v1.3.0 operator manifest and waits for the controller to be Available. The operator installs three CRDs: `RayCluster`, `RayJob`, `RayService`.

### Phase 5 — Build K8s manifests

```bash
npm run build:k8s
```

Runs `chant build src --lexicon k8s`, producing `k8s.yaml` — Namespace, StorageClass, ServiceAccount, ClusterRole, NetworkPolicy, PodDisruptionBudget, PVC, and RayCluster CR.

### Phase 6 — Apply K8s manifests and verify

```bash
kubectl apply -f k8s.yaml
just wait          # waits for RayCluster state=ready
just test-job      # submits ray.cluster_resources() to verify head + workers
```

Open the dashboard:

```bash
just dashboard     # → http://localhost:8265
```

## Configuration

Set these environment variables before building or running `just` targets:

| Variable | Default | Description |
|---|---|---|
| `GCP_PROJECT_ID` | `my-project` | GCP project ID |
| `GCP_REGION` | `us-central1` | Region for GKE cluster and Filestore |
| `GKE_CLUSTER_NAME` | `ray-gke` | GKE cluster name |
| `RAY_GSA_EMAIL` | `ray-workload@my-project.iam.gserviceaccount.com` | GCP service account email for Workload Identity |
| `RAY_IMAGE` | `us-central1-docker.pkg.dev/my-project/ray-images/ray:2.40.0` | Pre-built Ray image in Artifact Registry |

## Cost

GKE cluster (3× n2-standard-4) + Filestore ENTERPRISE (1Ti) + NAT gateway ≈ $300+/mo while running. The GPU node pool scales to zero — GPUs only cost money when a job is scheduled. Tear down after testing.

## Tear down

```
Tear down the ray-kuberay-gke example. GCP_PROJECT_ID=my-project-id.
```

Or manually:

```bash
just teardown
```

## Further reading

- [Full tutorial](../../docs/src/content/docs/tutorials/ray-kuberay-gke.mdx) — architecture diagrams, key patterns (NetworkPolicy strategy, GCS spillover, preStop hooks, pre-built images), and deploy order explained
- [K8s lexicon RayCluster/RayJob/RayService](/chant/lexicons/k8s/) — use `/chant-k8s-ray` skill for composite reference
- [GCP lexicon](/chant/lexicons/gcp/) — `GkeCluster`, `FilestoreInstance`, `GcsBucket`, `ArtifactRegistryRepository`, IAM composites
