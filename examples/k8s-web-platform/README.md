# K8s Web Platform

Production web platform demonstrating web-facing composites: TLS ingress with cert-manager, Envoy sidecar proxy, network isolation, shared EFS storage, and Prometheus monitoring patterns.

## Skills

This example includes skills for agent-guided deployment:

| Skill | Purpose |
|-------|---------|
| `chant-k8s-web-platform` | Guides the full deploy → verify → teardown workflow for this example |
| `chant-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-k8s-patterns` | Advanced patterns: sidecars, config mounting, TLS, monitoring, network isolation |

> **Using Claude Code?** The skills in `.claude/skills/` guide your agent
> through the full deploy → verify → teardown workflow. Just ask:
>
> ```
> Deploy the k8s-web-platform example to my cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 11 Kubernetes resources across 6 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/namespace.ts` | *(raw Namespace)* | Namespace |
| `src/frontend.ts` | `WebApp` | Deployment + Service + PodDisruptionBudget |
| `src/api.ts` | `SidecarApp` | Deployment + Service (with Envoy sidecar) |
| `src/ingress.ts` | `SecureIngress` | Ingress (TLS via cert-manager) |
| `src/network.ts` | `NetworkIsolatedApp` | Deployment + Service + NetworkPolicy |
| `src/storage.ts` | `EfsStorageClass` | StorageClass (AWS EFS) |

## Composites covered

This example showcases 5 composites for web-facing workload patterns:

| Composite | Pattern | Key features |
|-----------|---------|-------------|
| `WebApp` | Frontend service | 2 replicas, PDB (minAvailable: 1), nginx |
| `SidecarApp` | API with proxy | Envoy sidecar, shared volumes, 3 replicas |
| `SecureIngress` | TLS ingress | cert-manager, letsencrypt-prod, multi-path routing |
| `NetworkIsolatedApp` | Zero-trust API | Ingress from frontend only, egress to postgres + DNS |
| `EfsStorageClass` | Shared storage | AWS EFS CSI, ReadWriteMany, directory permissions |

## Prerequisites

- [ ] [Bun](https://bun.sh)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster with:
  - [cert-manager](https://cert-manager.io/) installed (for TLS)
  - [nginx ingress controller](https://kubernetes.github.io/ingress-nginx/) (for Ingress class)
  - [AWS EFS CSI driver](https://github.com/kubernetes-sigs/aws-efs-csi-driver) (for EfsStorageClass)

**Local verification** (build, lint, test) requires only Bun — no cluster or add-ons needed.

## Local verification

```bash
bun run build
bun run lint
```

## Deploy

```bash
bun run deploy
```

This runs: build → apply → wait → status.

### Step by step

1. **Build** — generates `k8s.yaml` with all 11 resources:

   ```bash
   bun run build
   ```

2. **Apply** — deploys to the current kubectl context:

   ```bash
   bun run apply
   ```

3. **Wait** — waits for the frontend deployment to roll out:

   ```bash
   bun run wait
   ```

## Verify

```bash
bun run status                                  # Pod listing
bun run logs                                    # Frontend logs
kubectl get ingress -n web-platform             # Ingress status and address
kubectl get certificate -n web-platform         # TLS certificate status
kubectl get networkpolicy -n web-platform       # Network policies
kubectl get storageclass efs-shared             # StorageClass
```

## Teardown

```bash
bun run teardown
```

Deletes all resources created by `kubectl apply`.

## Related examples

- [k8s-batch-workers](../k8s-batch-workers/) — Batch processing with workers, cron, jobs
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon
