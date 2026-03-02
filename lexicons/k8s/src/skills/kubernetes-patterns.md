---
skill: kubernetes-patterns
description: Kubernetes deployment strategies, stateful workloads, RBAC, and networking patterns
user-invocable: true
---

# Kubernetes Infrastructure Patterns

## Deployment Strategies

### Rolling Update (default)

Gradually replaces pods with zero downtime. Configure surge and unavailability:

```typescript
import { WebApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service } = WebApp({
  name: "api",
  image: "api:2.0",
  replicas: 4,
  strategy: {
    type: "RollingUpdate",
    rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" },
  },
});
```

### Blue/Green Deployment

Run two full deployments and switch traffic by updating the Service selector:

```typescript
import { WebApp } from "@intentius/chant-lexicon-k8s";

const blue = WebApp({ name: "app-blue", image: "app:1.0", replicas: 3 });
const green = WebApp({ name: "app-green", image: "app:2.0", replicas: 3 });

// Switch traffic: update the Service selector to point at green
// kubectl patch svc app -p '{"spec":{"selector":{"version":"green"}}}'
```

### Canary Deployment

Deploy a small replica set alongside the main deployment to test new versions:

```typescript
import { AutoscaledService, WebApp } from "@intentius/chant-lexicon-k8s";

const main = AutoscaledService({
  name: "app",
  image: "app:1.0",
  port: 8080,
  minReplicas: 9,
  maxReplicas: 20,
});

const canary = WebApp({
  name: "app-canary",
  image: "app:2.0",
  replicas: 1,
  labels: { track: "canary" },
});
```

Both share the same `app.kubernetes.io/name` label so the Service routes traffic to both.

## Stateful Workloads

### StatefulSet with Persistent Storage

Use `StatefulApp` for databases, caches, and other stateful services:

```typescript
import { StatefulApp } from "@intentius/chant-lexicon-k8s";

const { statefulSet, service } = StatefulApp({
  name: "postgres",
  image: "postgres:16",
  port: 5432,
  replicas: 3,
  storageSize: "50Gi",
  storageClass: "gp3-encrypted",
  env: [
    { name: "POSTGRES_DB", value: "app" },
    { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "pg-creds", key: "password" } } },
  ],
});
```

### Headless Service for StatefulSet Discovery

`StatefulApp` creates a headless Service (`clusterIP: None`) automatically. Pods are addressable as `postgres-0.postgres.namespace.svc.cluster.local`.

### PersistentVolumeClaim Retention

StatefulSet PVCs persist after pod deletion by default. To clean up:

```bash
kubectl delete pvc -l app.kubernetes.io/name=postgres
```

## RBAC Patterns

### Least-Privilege ServiceAccount

Use `WorkerPool` or `BatchJob` composites which create scoped RBAC automatically:

```typescript
import { WorkerPool } from "@intentius/chant-lexicon-k8s";

const { deployment, serviceAccount, role, roleBinding } = WorkerPool({
  name: "queue-worker",
  image: "worker:1.0",
  replicas: 3,
  rbacRules: [
    { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "list"] },
    { apiGroups: ["batch"], resources: ["jobs"], verbs: ["create"] },
  ],
});
```

### Namespace-Scoped vs Cluster-Scoped

- Use `Role` + `RoleBinding` for namespace-scoped permissions (default in composites)
- Use `ClusterRole` + `ClusterRoleBinding` for cross-namespace access (node agents, monitoring)

```typescript
import { NodeAgent } from "@intentius/chant-lexicon-k8s";

const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding } = NodeAgent({
  name: "log-agent",
  image: "fluent-bit:2.2",
  rbacRules: [
    { apiGroups: [""], resources: ["pods", "namespaces"], verbs: ["get", "list", "watch"] },
  ],
});
```

## Networking Patterns

### Default-Deny with Selective Allow

Use `NamespaceEnv` for namespace-level isolation, then `NetworkIsolatedApp` for per-app rules:

```typescript
import { NamespaceEnv, NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";

const ns = NamespaceEnv({
  name: "prod",
  defaultDenyIngress: true,
  defaultDenyEgress: true,
  cpuLimit: "8",
  memoryLimit: "16Gi",
});

const app = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  namespace: "prod",
  allowIngressFrom: [
    { podSelector: { "app.kubernetes.io/name": "gateway" } },
  ],
  allowEgressTo: [
    { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
  ],
});
```

### Service Mesh (Istio/Linkerd)

For mTLS between services, use a sidecar-injected namespace:

```bash
kubectl label namespace prod istio-injection=enabled
```

Then deploy with standard composites. The mesh proxy is injected automatically.

### DNS-Based Service Discovery

Services are discoverable at `<service>.<namespace>.svc.cluster.local`. For headless services (StatefulSets), individual pods are at `<pod>.<service>.<namespace>.svc.cluster.local`.
