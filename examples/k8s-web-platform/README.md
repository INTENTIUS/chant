# K8s Web Platform

Production web platform demonstrating web-facing composites: TLS ingress with cert-manager, Envoy sidecar proxy, network isolation, shared EFS storage, and Prometheus monitoring.

## Composites covered

| File | Composite | Description |
|------|-----------|-------------|
| `namespace.ts` | *(raw Namespace)* | Namespace for web workloads |
| `frontend.ts` | `WebApp` | Frontend with PDB |
| `api.ts` | `SidecarApp` | API with envoy sidecar |
| `ingress.ts` | `SecureIngress` | TLS Ingress with cert-manager (Certificate tested structurally) |
| `network.ts` | `NetworkIsolatedApp` | API with ingress/egress NetworkPolicy |
| `storage.ts` | `EfsStorageClass` | Shared EFS StorageClass |

CRD composites (`MonitoredService`, `SecureIngress` Certificate) are tested structurally in the test file since their output types are not in the k8s lexicon's generated resource index.

## Resource count

**11 Kubernetes resources** across 6 source files:

- 3 Deployments (frontend, api, api-isolated)
- 3 Services (frontend, api, api-isolated)
- 1 PodDisruptionBudget (frontend)
- 1 Ingress (web-platform)
- 1 NetworkPolicy (api-isolated)
- 1 StorageClass (efs-shared)
- 1 Namespace

## Prerequisites

- [Bun](https://bun.sh)
- [kubectl](https://kubernetes.io/docs/tasks/tools/) (for deploy/teardown)

## Usage

```bash
# Build K8s manifests
bun run build

# Lint
bun run lint

# Deploy
bun run deploy

# Cleanup
bun run teardown
```

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — Full EKS cross-lexicon example
- [k8s-batch-workers](../k8s-batch-workers/) — Batch processing with workers, cron, jobs
