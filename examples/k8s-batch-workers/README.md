# K8s Batch Workers

Background processing platform demonstrating batch and worker composites: queue workers with autoscaling, scheduled jobs, one-shot migrations, config-driven API, and per-node log collection.

## Skills

This example includes skills for agent-guided deployment:

| Skill | Purpose |
|-------|---------|
| `chant-k8s-batch-workers` | Guides the full deploy → verify → teardown workflow for this example |
| `chant-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-k8s-patterns` | Advanced patterns: sidecars, config mounting, TLS, monitoring, network isolation |

> **Using Claude Code?** The skills in `.claude/skills/` guide your agent
> through the full deploy → verify → teardown workflow. Just ask:
>
> ```
> Deploy the k8s-batch-workers example to my cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 23 Kubernetes resources across 6 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/namespace.ts` | *(raw Namespace)* | Namespace |
| `src/workers.ts` | `WorkerPool` | Deployment + ServiceAccount + Role + RoleBinding + ConfigMap + HPA |
| `src/cron.ts` | `CronWorkload` | CronJob + ServiceAccount + Role + RoleBinding |
| `src/migration.ts` | `BatchJob` | Job + ServiceAccount + Role + RoleBinding |
| `src/task-api.ts` | `ConfiguredApp` | Deployment + Service + ConfigMap |
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

- [ ] [Bun](https://bun.sh)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster (k3d, kind, minikube, or any existing cluster)

**Local verification** (build, lint, test) requires only Bun — no cluster needed.

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

1. **Build** — generates `k8s.yaml` with all 23 resources:

   ```bash
   bun run build
   ```

2. **Apply** — deploys to the current kubectl context:

   ```bash
   bun run apply
   ```

3. **Wait** — waits for the queue-worker deployment to roll out:

   ```bash
   bun run wait
   ```

## Verify

```bash
bun run status                                  # Pod listing
bun run logs                                    # Queue worker logs
kubectl get cronjob -n batch-workers            # Scheduled jobs
kubectl get job -n batch-workers                # One-shot jobs
kubectl get daemonset -n batch-workers          # Log collector
kubectl get hpa -n batch-workers                # Autoscaler status
```

## Teardown

```bash
bun run teardown
```

Deletes all resources created by `kubectl apply`.

## Related examples

- [k8s-web-platform](../k8s-web-platform/) — Web platform with ingress, sidecars, monitoring
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon
