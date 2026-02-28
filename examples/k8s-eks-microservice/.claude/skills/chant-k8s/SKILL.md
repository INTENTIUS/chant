---
skill: chant-k8s
description: Build, validate, and deploy Kubernetes manifests from a chant project
user-invocable: true
---

# Kubernetes Operational Playbook

## How chant and Kubernetes relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into Kubernetes YAML manifests. chant does NOT call the Kubernetes API. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **kubectl / k8s API** for: apply, rollback, monitoring, troubleshooting

The source of truth for infrastructure is the TypeScript in `src/`. The generated YAML manifests are intermediate artifacts — never edit them by hand.

## Scaffolding a new project

### Initialize with a template

```bash
chant init --lexicon k8s                          # default: Deployment + Service
chant init --lexicon k8s --template microservice   # Deployment + Service + HPA + PDB
chant init --lexicon k8s --template stateful       # StatefulSet + PVC + Service
```

### Available templates

| Template | What it generates | Best for |
|----------|-------------------|----------|
| *(default)* | Deployment + Service | Simple stateless apps |
| `microservice` | Deployment + Service + HPA + PDB | Production microservices |
| `stateful` | StatefulSet + PVC + headless Service | Databases, caches |

## Build and validate

### Build manifests

```bash
chant build src/ --output manifests.yaml
```

Options:
- `--format yaml` — emit YAML (default for K8s)
- `--watch` — rebuild on source changes
- `--output <path>` — write to a specific file

### Lint the source

```bash
chant lint src/
```

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| `chant lint` | Hardcoded namespaces (WK8001) | Every edit |
| `chant build` | Post-synth: secrets in env (WK8005), latest tags (WK8006), API keys (WK8041), missing probes (WK8301), no resource limits (WK8201), privileged containers (WK8202), and more | Before apply |
| `kubectl --dry-run=server` | K8s API validation: schema errors, admission webhooks | Before production apply |

## Deploying to Kubernetes

### Apply manifests

```bash
# Build
chant build src/ --output manifests.yaml

# Dry run first
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
```

### Check rollout status

```bash
kubectl rollout status deployment/my-app
```

### Rollback

```bash
kubectl rollout undo deployment/my-app
kubectl rollout undo deployment/my-app --to-revision=2
```

## Debugging strategies

### Check pod status and events

```bash
# Overview
kubectl get pods -l app.kubernetes.io/name=my-app
kubectl get events --sort-by=.lastTimestamp -n <namespace>

# Deep dive into a specific pod
kubectl describe pod <pod-name>

# Logs (current and previous crash)
kubectl logs <pod-name>
kubectl logs <pod-name> --previous
kubectl logs <pod-name> -c <container-name>  # specific container
kubectl logs deployment/my-app --all-containers

# Debug containers (K8s 1.25+)
kubectl debug <pod-name> -it --image=busybox --target=<container>

# Port-forwarding for local testing
kubectl port-forward svc/my-app 8080:80
kubectl port-forward pod/<pod-name> 8080:8080
```

### Common error patterns

| Status | Meaning | Diagnostic command | Typical fix |
|--------|---------|-------------------|-------------|
| Pending | Not scheduled | `kubectl describe pod` → Events | Check resource requests, node selectors, taints, PVC binding |
| CrashLoopBackOff | App crashing on start | `kubectl logs --previous` | Fix app startup, check probe config, increase initialDelaySeconds |
| ImagePullBackOff | Image not found | `kubectl describe pod` → Events | Verify image name/tag, check imagePullSecrets, registry auth |
| OOMKilled | Out of memory | `kubectl describe pod` → Last State | Increase memory limit, profile app memory usage |
| Evicted | Node disk/memory pressure | `kubectl describe node` | Increase limits, add node capacity, check for log/tmp bloat |
| CreateContainerError | Container config issue | `kubectl describe pod` → Events | Check volume mounts, configmap/secret refs, security context |
| Init:CrashLoopBackOff | Init container failing | `kubectl logs -c <init-container>` | Fix init container command, check dependencies |

## Production safety

### Pre-apply validation

```bash
# Always diff before applying
kubectl diff -f manifests.yaml

# Server-side dry run (validates with admission webhooks)
kubectl apply -f manifests.yaml --dry-run=server

# Client-side dry run (fast, but no webhook validation)
kubectl apply -f manifests.yaml --dry-run=client
```

### Deployment strategies

- **RollingUpdate** (default): Gradually replaces pods. Set `maxSurge` and `maxUnavailable`.
- **Recreate**: All pods terminated before new ones created. Use for stateful apps that cannot run multiple versions.
- **Canary**: Deploy a second Deployment with 1 replica + same selector labels. Route percentage via Ingress annotations or service mesh.
- **Blue/Green**: Two full Deployments (blue/green), switch Service selector between them.

## Choosing the Right Composite

Composites are higher-level functions that produce multiple coordinated K8s resources from a single call. They return plain prop objects — not class instances.

### Decision Tree

| Need | Composite | Resources |
|------|-----------|-----------|
| Stateless web app | **WebApp** | Deployment + Service + optional Ingress + optional PDB |
| Stateful database/cache | **StatefulApp** | StatefulSet + headless Service + PVC + optional PDB |
| Production HTTP service with autoscaling | **AutoscaledService** | Deployment + Service + HPA + PDB |
| Background queue workers | **WorkerPool** | Deployment + RBAC + optional ConfigMap + optional HPA + optional PDB |
| Scheduled jobs | **CronWorkload** | CronJob + RBAC |
| One-shot batch jobs | **BatchJob** | Job + optional RBAC |
| App with ConfigMap/Secret mounts | **ConfiguredApp** | Deployment + Service + optional ConfigMap |
| Multi-container sidecar patterns | **SidecarApp** | Deployment + Service |
| App with Prometheus monitoring | **MonitoredService** | Deployment + Service + ServiceMonitor + optional PrometheusRule |
| App with fine-grained network policies | **NetworkIsolatedApp** | Deployment + Service + NetworkPolicy |
| Namespace with quotas and isolation | **NamespaceEnv** | Namespace + ResourceQuota + LimitRange + NetworkPolicy |
| Per-node agent (custom) | **NodeAgent** | DaemonSet + RBAC + optional ConfigMap |
| Multi-host TLS Ingress (cert-manager) | **SecureIngress** | Ingress + optional Certificate |
| EKS IRSA ServiceAccount | **IrsaServiceAccount** | ServiceAccount + optional RBAC |
| AWS ALB Ingress | **AlbIngress** | Ingress with ALB annotations |
| EBS StorageClass | **EbsStorageClass** | StorageClass (ebs.csi.aws.com) |
| EFS StorageClass | **EfsStorageClass** | StorageClass (efs.csi.aws.com) |
| Fluent Bit for CloudWatch | **FluentBitAgent** | DaemonSet + RBAC + ConfigMap |
| ExternalDNS for Route53 | **ExternalDnsAgent** | Deployment + IRSA SA + ClusterRole |
| ADOT for CloudWatch/X-Ray | **AdotCollector** | DaemonSet + RBAC + ConfigMap |

### Hardening options (available on Deployment-based composites)

- `minAvailable` — creates a PodDisruptionBudget (WebApp, StatefulApp, WorkerPool; AutoscaledService always has one)
- `initContainers` — run before main containers (WebApp, StatefulApp, AutoscaledService, ConfiguredApp, SidecarApp)
- `securityContext` — container security settings (WebApp, StatefulApp, AutoscaledService, WorkerPool)
- `terminationGracePeriodSeconds` — graceful shutdown (WebApp, StatefulApp, AutoscaledService, WorkerPool)
- `priorityClassName` — pod scheduling priority (WebApp, StatefulApp, AutoscaledService, WorkerPool)

### Common patterns across all composites

- All resources carry `app.kubernetes.io/name`, `app.kubernetes.io/managed-by: chant`, and `app.kubernetes.io/component` labels
- Pass `labels: { team: "platform" }` to add extra labels to all resources
- Pass `namespace: "prod"` to set namespace on all namespaced resources
- Pass `env: [{ name: "KEY", value: "val" }]` for container environment variables

## Troubleshooting reference table

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| Pod stuck in Pending | Insufficient CPU/memory on nodes | Scale up cluster or reduce resource requests |
| Pod stuck in Pending | PVC not bound | Check StorageClass exists, PV available |
| Pod stuck in Pending | Node selector/affinity mismatch | Verify node labels match selectors |
| Pod stuck in ContainerCreating | ConfigMap/Secret not found | Ensure referenced ConfigMaps/Secrets exist |
| Service returns 503 | No ready endpoints | Check pod readiness probes, selector match |
| Ingress returns 404 | Backend service not found | Check Ingress rules, service name/port |
| HPA not scaling | Metrics server not installed | Install metrics-server |
| HPA not scaling | Resource requests not set | Add CPU/memory requests to containers |
| CronJob not running | Invalid cron expression | Validate cron syntax (5-field format) |
| NetworkPolicy blocking | Default deny applied | Add explicit allow rules for required traffic |
| RBAC permission denied | Missing Role/RoleBinding | Check ServiceAccount bindings and verb permissions |

## Quick reference

```bash
# Build
chant build src/ --output manifests.yaml

# Lint
chant lint src/

# Validate
kubectl apply -f manifests.yaml --dry-run=server

# Diff
kubectl diff -f manifests.yaml

# Apply
kubectl apply -f manifests.yaml

# Status
kubectl get pods,svc,deploy

# Logs
kubectl logs deployment/my-app

# Rollback
kubectl rollout undo deployment/my-app

# Debug
kubectl describe pod <name>
kubectl logs <name> --previous
kubectl get events --sort-by=.lastTimestamp
```
