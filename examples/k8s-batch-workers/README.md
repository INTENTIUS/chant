# K8s Batch Workers

Background processing platform demonstrating batch and worker composites: queue workers with autoscaling, scheduled jobs, one-shot migrations, config-driven API, and per-node log collection.

## Composites covered

| File | Composite | Description |
|------|-----------|-------------|
| `namespace.ts` | *(raw Namespace)* | Namespace for batch workloads |
| `workers.ts` | `WorkerPool` | Queue consumer with HPA, ConfigMap, RBAC |
| `cron.ts` | `CronWorkload` | Nightly cleanup with schedule and RBAC |
| `migration.ts` | `BatchJob` | Data migration with retry and TTL |
| `task-api.ts` | `ConfiguredApp` | API with mounted config, secret volume, envFrom |
| `log-collector.ts` | `NodeAgent` | DaemonSet with hostPaths, config, ClusterRole |

## Resource count

**23 Kubernetes resources** across 6 source files:

- 2 Deployments (queue-worker, task-api)
- 1 Service (task-api)
- 4 ServiceAccounts
- 3 Roles + 3 RoleBindings
- 1 ClusterRole + 1 ClusterRoleBinding (log-collector)
- 3 ConfigMaps
- 1 CronJob, 1 Job, 1 DaemonSet, 1 HPA, 1 Namespace

## Prerequisites

- [Bun](https://bun.sh)
- [just](https://github.com/casey/just) — command runner
- [kubectl](https://kubernetes.io/docs/tasks/tools/) (for deploy/teardown)

## Usage

```bash
# Build K8s manifests
just build

# Lint
just lint

# Deploy
just deploy

# Cleanup
just teardown
```

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — Full EKS cross-lexicon example
- [k8s-web-platform](../k8s-web-platform/) — Web platform with ingress, sidecars, monitoring
