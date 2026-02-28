---
skill: chant-k8s-batch-workers
description: Deploy and manage the K8s batch workers example
user-invocable: true
---

# K8s Batch Workers Example

This project demonstrates a background processing platform using K8s
composites: queue workers with autoscaling, scheduled jobs, one-shot
migrations, config-driven API, and per-node log collection.

See also the lexicon skills `chant-k8s` and `chant-k8s-patterns` for
composite reference and advanced patterns.

## Project layout

- `src/namespace.ts` — Namespace for batch workloads
- `src/workers.ts` — WorkerPool composite (Deployment + HPA + RBAC + ConfigMap)
- `src/cron.ts` — CronWorkload composite (CronJob + RBAC)
- `src/migration.ts` — BatchJob composite (Job + RBAC)
- `src/task-api.ts` — ConfiguredApp composite (Deployment + Service + ConfigMap)
- `src/log-collector.ts` — NodeAgent composite (DaemonSet + ClusterRole + ConfigMap)
- `src/chant.config.json` — lint configuration
- `k8s.yaml` — generated K8s manifests (do not edit)

## Local verification (no cluster required)

```bash
bun run build              # generates k8s.yaml (23 K8s resources)
bun run lint               # zero errors expected
```

Run tests from the repo root:

```bash
bun test examples/k8s-batch-workers/
```

## Deploy workflow

### Prerequisites

- A Kubernetes cluster (k3d, kind, minikube, or any existing cluster)
- kubectl configured to point at the cluster

### Full deploy

```bash
bun run deploy             # build → apply → wait → status
```

### Step by step

```bash
bun run build              # generate k8s.yaml
bun run apply              # kubectl apply -f k8s.yaml
bun run wait               # wait for queue-worker rollout
bun run status             # check pod status
```

## Verify

```bash
bun run status             # pod listing
bun run logs               # queue-worker logs
kubectl get cronjob -n batch-workers
kubectl get job -n batch-workers
kubectl get daemonset -n batch-workers
```

## Teardown

```bash
bun run teardown           # kubectl delete -f k8s.yaml
```

## Troubleshooting

- Worker pods pending → check node resources: `kubectl describe pod -n batch-workers`
- HPA not scaling → ensure metrics-server is installed
- CronJob not running → verify cron expression: `kubectl get cronjob -n batch-workers`
- DaemonSet missing pods → check tolerations and node taints
