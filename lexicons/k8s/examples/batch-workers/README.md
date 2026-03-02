# K8s Batch Workers

Background processing platform demonstrating batch and worker composites: queue workers with autoscaling, scheduled jobs, one-shot migrations, config-driven API, and per-node log collection.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced patterns: sidecars, config mounting, TLS, monitoring, network isolation |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the k8s-batch-workers example to my cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 26 Kubernetes resources across 6 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/namespace.ts` | *(raw Namespace)* | Namespace |
| `src/workers.ts` | `WorkerPool` | Deployment + ServiceAccount + Role + RoleBinding + ConfigMap + HPA + PDB |
| `src/cron.ts` | `CronWorkload` | CronJob + ServiceAccount + Role + RoleBinding |
| `src/migration.ts` | `BatchJob` | Job + ServiceAccount + Role + RoleBinding |
| `src/task-api.ts` | `ConfiguredApp` | Deployment + Service + ConfigMap + 2 Secrets |
| `src/log-collector.ts` | `NodeAgent` | DaemonSet + ServiceAccount + ClusterRole + ClusterRoleBinding + ConfigMap |

## Composites covered

This example showcases 5 composites for different workload patterns:

| Composite | Pattern | Key features |
|-----------|---------|-------------|
| `WorkerPool` | Queue consumer | HPA autoscaling (2-10 replicas, 75% CPU), RBAC, ConfigMap |
| `CronWorkload` | Scheduled task | Cron schedule (`0 2 * * *`), job history limits, RBAC |
| `BatchJob` | One-shot migration | Retry (backoffLimit: 3), TTL cleanup (1h), RBAC |
| `ConfiguredApp` | Config-driven API | ConfigMap volume mount, secret volume, envFrom |
| `NodeAgent` | Per-node DaemonSet | hostPath volumes, ClusterRole, tolerate-all taints |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster (k3d, kind, minikube, or any existing cluster)

**Local verification** (build, lint, test) requires only Node.js — no cluster needed.

## Local verification

```bash
npx chant build src --lexicon k8s -o k8s.yaml
npx chant lint src
```

## Deploy

### Step by step

1. **Build** — generates `k8s.yaml` with all 26 resources:

   ```bash
   npx chant build src --lexicon k8s -o k8s.yaml
   ```

2. **Apply** — deploys to the current kubectl context:

   ```bash
   kubectl apply -f k8s.yaml
   ```

3. **Wait** — waits for the queue-worker deployment to roll out:

   ```bash
   kubectl -n batch-workers rollout status deployment/queue-worker --timeout=120s
   ```

## Verify

```bash
kubectl get pods -n batch-workers               # Pod listing
kubectl logs -n batch-workers -l app.kubernetes.io/name=queue-worker --tail=50  # Queue worker logs
kubectl get cronjob -n batch-workers            # Scheduled jobs
kubectl get job -n batch-workers                # One-shot jobs
kubectl get daemonset -n batch-workers          # Log collector
kubectl get hpa -n batch-workers                # Autoscaler status
```

## Teardown

```bash
kubectl delete -f k8s.yaml
```

Deletes all resources created by `kubectl apply`.

## Related examples

- [k8s-web-platform](../k8s-web-platform/) — Web platform with ingress, sidecars, monitoring
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
