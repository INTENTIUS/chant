---
skill: chant-k8s-patterns
description: Advanced Kubernetes deployment patterns and composites
user-invocable: true
---

# Advanced Kubernetes Patterns

## Sidecar Patterns

### SidecarApp — multi-container Deployment

```typescript
import { SidecarApp } from "@intentius/chant-lexicon-k8s";

// Envoy sidecar proxy
const { deployment, service } = SidecarApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  sidecars: [
    {
      name: "envoy",
      image: "envoyproxy/envoy:v1.28",
      ports: [{ containerPort: 9901, name: "admin" }],
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "200m", memory: "256Mi" } },
    },
  ],
  initContainers: [
    { name: "migrate", image: "api:1.0", command: ["python", "manage.py", "migrate"] },
  ],
  sharedVolumes: [{ name: "tmp", emptyDir: {} }],
});
```

Common sidecar use cases:
- **Envoy proxy** — service mesh, mTLS, traffic management
- **Log forwarder** — Fluent Bit sidecar for app-specific log routing
- **Auth proxy** — OAuth2 Proxy for authentication
- **Config watcher** — reload config on ConfigMap changes

## Config and Secret Mounting

### ConfiguredApp — automatic volume wiring

```typescript
import { ConfiguredApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service, configMap } = ConfiguredApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  // Mount ConfigMap as volume
  configData: { "app.conf": "key=value\nother=setting" },
  configMountPath: "/etc/api",
  // Mount existing Secret as volume
  secretName: "api-creds",
  secretMountPath: "/secrets",
  // Inject as environment variables
  envFrom: { secretRef: "api-env-secret", configMapRef: "api-env-config" },
  // Run migrations before the app starts
  initContainers: [
    { name: "migrate", image: "api:1.0", command: ["./migrate.sh"] },
  ],
});
```

### Volume patterns

| Pattern | Use Case | ConfiguredApp Props |
|---------|----------|---------------------|
| ConfigMap as file | Config files, templates | `configData` + `configMountPath` |
| Secret as file | TLS certs, credentials | `secretName` + `secretMountPath` |
| ConfigMap as env | Simple key-value config | `envFrom.configMapRef` |
| Secret as env | Database URLs, API keys | `envFrom.secretRef` |

## TLS / cert-manager

### SecureIngress — multi-host TLS with cert-manager

```typescript
import { SecureIngress } from "@intentius/chant-lexicon-k8s";

const { ingress, certificate } = SecureIngress({
  name: "app-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [
        { path: "/v1", serviceName: "api-v1", servicePort: 80 },
        { path: "/v2", serviceName: "api-v2", servicePort: 80 },
      ],
    },
    {
      hostname: "admin.example.com",
      paths: [{ path: "/", serviceName: "admin", servicePort: 80 }],
    },
  ],
  clusterIssuer: "letsencrypt-prod",
  ingressClassName: "nginx",
});
```

Features:
- Multiple hosts and paths per Ingress
- Automatic cert-manager Certificate when `clusterIssuer` set
- TLS secret auto-provisioned by cert-manager

### cert-manager setup (prerequisite)

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# Create ClusterIssuer for Let's Encrypt
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

## Observability

### MonitoredService — Prometheus monitoring

```typescript
import { MonitoredService } from "@intentius/chant-lexicon-k8s";

const { deployment, service, serviceMonitor, prometheusRule } = MonitoredService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  metricsPort: 9090,
  metricsPath: "/metrics",
  scrapeInterval: "15s",
  alertRules: [
    {
      name: "HighErrorRate",
      expr: 'rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05',
      for: "5m",
      severity: "critical",
      annotations: { summary: "High error rate on {{ $labels.instance }}" },
    },
    {
      name: "HighLatency",
      expr: 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 1',
      for: "10m",
      severity: "warning",
    },
  ],
});
```

### Prerequisites

- Prometheus Operator installed (for ServiceMonitor/PrometheusRule CRDs)
- Prometheus configured to discover ServiceMonitors

## Network Isolation

### NetworkIsolatedApp — per-app firewall rules

```typescript
import { NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service, networkPolicy } = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  allowIngressFrom: [
    { podSelector: { "app.kubernetes.io/name": "frontend" } },
    { namespaceSelector: { "kubernetes.io/metadata.name": "monitoring" } },
  ],
  allowEgressTo: [
    { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
    { podSelector: { "app.kubernetes.io/name": "redis" }, ports: [{ port: 6379 }] },
  ],
});
```

### Combining with NamespaceEnv

Use NamespaceEnv for namespace-level default-deny, then NetworkIsolatedApp for per-app allow rules:

```typescript
// Namespace: deny all by default
const ns = NamespaceEnv({ name: "prod", defaultDenyIngress: true, defaultDenyEgress: true });

// App: allow specific traffic
const app = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  namespace: "prod",
  allowIngressFrom: [{ podSelector: { "app.kubernetes.io/name": "gateway" } }],
  allowEgressTo: [{ podSelector: { "app.kubernetes.io/name": "db" }, ports: [{ port: 5432 }] }],
});
```

## Blue/Green and Canary

These patterns use standard K8s resources — no special composite needed.

### Blue/Green

```typescript
// Two Deployments with different versions
const blue = WebApp({ name: "app-blue", image: "app:1.0", labels: { version: "blue" } });
const green = WebApp({ name: "app-green", image: "app:2.0", labels: { version: "green" } });

// Service points to active version — switch by changing selector
// Active: blue → green (update the Service selector)
```

### Canary

```typescript
// Main deployment (90% traffic)
const main = AutoscaledService({ name: "app", image: "app:1.0", minReplicas: 9, maxReplicas: 20, ... });

// Canary deployment (10% traffic) — same app label, fewer replicas
const canary = WebApp({ name: "app-canary", image: "app:2.0", replicas: 1, labels: { track: "canary" } });
// Both share the same Service selector ("app.kubernetes.io/name": "app") for traffic splitting
```

## Gateway API (future direction)

Gateway API is the successor to Ingress. Key differences:
- **HTTPRoute** replaces Ingress rules
- **Gateway** replaces IngressClass
- Built-in traffic splitting, header matching, URL rewriting
- Currently in beta — use Ingress/SecureIngress/AlbIngress for production today

When Gateway API reaches GA, new composites will be added. For now, use CRD import if you need Gateway API resources.
