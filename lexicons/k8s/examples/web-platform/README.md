# K8s Web Platform

Production web platform demonstrating web-facing composites: TLS ingress with cert-manager, Envoy sidecar proxy, network isolation, shared EFS storage, and Prometheus monitoring patterns.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced patterns: sidecars, config mounting, TLS, monitoring, network isolation |

> **Using Claude Code?** Just ask:
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
| `src/api.ts` | `SidecarApp` | Deployment + Service (with nginx reverse-proxy sidecar) |
| `src/ingress.ts` | `SecureIngress` | Ingress (TLS via cert-manager) |
| `src/network.ts` | `NetworkIsolatedApp` | Deployment + Service + NetworkPolicy |
| `src/storage.ts` | `EfsStorageClass` | StorageClass (AWS EFS) |

## Composites covered

This example showcases 5 composites for web-facing workload patterns:

| Composite | Pattern | Key features |
|-----------|---------|-------------|
| `WebApp` | Frontend service | 2 replicas, PDB (minAvailable: 1), nginx |
| `SidecarApp` | API with proxy | nginx reverse-proxy sidecar, 3 replicas |
| `SecureIngress` | TLS ingress | cert-manager, letsencrypt-prod, multi-path routing |
| `NetworkIsolatedApp` | Zero-trust API | Ingress from frontend only, egress to postgres + DNS |
| `EfsStorageClass` | Shared storage | AWS EFS CSI, ReadWriteMany, directory permissions |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster with:
  - [cert-manager](https://cert-manager.io/) installed (for TLS)
  - [nginx ingress controller](https://kubernetes.github.io/ingress-nginx/) (for Ingress class)
  - [AWS EFS CSI driver](https://github.com/kubernetes-sigs/aws-efs-csi-driver) (for EfsStorageClass)

**Local verification** (build, lint, test) requires only Node.js — no cluster or add-ons needed.

## Local verification

```bash
npx chant build src --lexicon k8s -o k8s.yaml
npx chant lint src
```

## Deploy

> **Important:** If using an nginx ingress controller, wait for the admission webhook to be ready before applying. The Ingress resource triggers a validation webhook — if endpoints aren't available yet, `kubectl apply` will fail.
>
> ```bash
> kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=120s
> ```

### Step by step

1. **Build** — generates `k8s.yaml` with all 11 resources:

   ```bash
   npx chant build src --lexicon k8s -o k8s.yaml
   ```

2. **Apply** — deploys to the current kubectl context:

   ```bash
   kubectl apply -f k8s.yaml
   ```

3. **Wait** — waits for the frontend deployment to roll out:

   ```bash
   kubectl -n web-platform rollout status deployment/frontend --timeout=120s
   ```

## Verify

```bash
kubectl get pods -n web-platform                # Pod listing
kubectl logs -n web-platform -l app.kubernetes.io/name=frontend --tail=50  # Frontend logs
kubectl get ingress -n web-platform             # Ingress status and address
kubectl get certificate -n web-platform         # TLS certificate status
kubectl get networkpolicy -n web-platform       # Network policies
kubectl get storageclass efs-shared             # StorageClass
```

## Teardown

```bash
kubectl delete -f k8s.yaml
```

Deletes all resources created by `kubectl apply`.

## Related examples

- [k8s-batch-workers](../k8s-batch-workers/) — Batch processing with workers, cron, jobs
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
