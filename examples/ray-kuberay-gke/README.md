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

### Phase 0 — Bootstrap Config Connector (one-time)

Config Connector is a GKE addon that lets you manage GCP resources via `kubectl apply`. You need a management cluster with it installed before you can apply `config.yaml`.

If you don't have one:

```bash
export GCP_PROJECT_ID=my-project
just bootstrap   # ~5 minutes
```

This creates `ray-mgmt` — a single-node GKE cluster in `us-central1` with Config Connector and Workload Identity. All `kubectl apply -f config.yaml` commands run against this cluster. Config Connector reconciles the GCP resources (GKE cluster, Filestore, GCS, Artifact Registry, IAM) from there.

If you already have a Config Connector management cluster, skip this step and set your kubectl context to it before Phase 2.

**Other prerequisites:**
- `gcloud` CLI authenticated: `gcloud auth application-default login`
- Node.js 20+ — [https://nodejs.org](https://nodejs.org)
- `npm install` run from the repo root

### Phase 1 — Build GCP manifests

```bash
export GCP_PROJECT_ID=my-project GCP_REGION=us-central1
cd examples/ray-kuberay-gke
npm run build:gcp
```

Runs `chant build src --lexicon gcp`, producing `config.yaml` — Config Connector resources for the GKE cluster, GPU node pool, Filestore BASIC_HDD instance, GCS spillover bucket, Artifact Registry, and IAM bindings.

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

Installs the KubeRay operator v1.3.2 via Helm and waits for the controller to be Available. The operator installs three CRDs: `RayCluster`, `RayJob`, `RayService`.

### Phase 5 — Build K8s manifests

After the GCP infrastructure is ready, get the Filestore instance IP:

```bash
export FILESTORE_IP=$(gcloud filestore instances describe ray-filestore \
  --zone ${GCP_REGION:-us-central1}-a \
  --format='value(networks[0].ipAddresses[0])')
```

Then build:

```bash
FILESTORE_IP=$FILESTORE_IP npm run build:k8s
```

Runs `chant build src --lexicon k8s`, producing `k8s.yaml` — Namespace, static NFS PersistentVolume (backed by the CC-managed Filestore instance), ServiceAccount, ClusterRole, NetworkPolicy, PodDisruptionBudget, PVC, and RayCluster CR.

> **Why static NFS PV?** The Filestore CSI driver creates its own Filestore instance per PVC. Since the infra layer already provisions a Filestore instance via Config Connector, we mount it directly as an NFS PV — no extra instances, no CSI driver addon required.

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

## Job portability

Any Ray job that runs against a local KubeRay cluster runs unchanged against this GKE deployment. The Ray Jobs HTTP API is the same:

```bash
kubectl port-forward -n ray-system svc/ray-head-svc 8265:8265
ray job submit --address http://localhost:8265 -- python your_job.py
```

One pattern difference: local clusters often use `runtime_env` YAML for pip dependencies — convenient for iteration. At 10+ workers, `runtime_env` pip installs run on every restart and add significant startup time. The pre-built Artifact Registry image approach this example uses avoids that.

## Observability

Install Prometheus + Grafana via kube-prometheus-stack. The same Helm command works locally (k3d) and on GKE:

```bash
just install-monitoring
just grafana        # → http://localhost:3000, admin/admin
```

The Ray dashboard Metrics tab is enabled via `RAY_GRAFANA_HOST` — set automatically to the in-cluster Grafana service. To import Ray's pre-built dashboards into Grafana, copy the JSON files from the head pod:

```bash
HEAD=$(kubectl -n ray-system get pod -l ray.io/node-type=head -o name | head -1)
kubectl -n ray-system exec "$HEAD" -- \
  ls /tmp/ray/session_latest/metrics/grafana/dashboards/
```

For local development:

```bash
just local-up
just local-monitoring   # install monitoring in k3d
just grafana
```

## Configuration

Set these environment variables before building or running `just` targets:

| Variable | Default | Description |
|---|---|---|
| `GCP_PROJECT_ID` | `my-project` | GCP project ID |
| `GCP_REGION` | `us-central1` | Region for GKE cluster and Filestore |
| `GKE_CLUSTER_NAME` | `ray-gke` | GKE cluster name |
| `RAY_GSA_EMAIL` | `ray-workload@my-project.iam.gserviceaccount.com` | GCP service account email for Workload Identity |
| `RAY_IMAGE` | `us-central1-docker.pkg.dev/my-project/ray-images/ray:2.54.0` | Pre-built Ray image in Artifact Registry |
| `RAY_GRAFANA_HOST` | `http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local` | Grafana URL for Ray dashboard Metrics tab |

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
