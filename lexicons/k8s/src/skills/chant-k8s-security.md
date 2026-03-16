---
skill: chant-k8s-security
description: Kubernetes pod security, image scanning, network policies, and secrets management
user-invocable: true
---

# Kubernetes Security Patterns

## Pod Security

### Security Context (container-level)

All Deployment-based composites accept `securityContext` for hardened containers:

```typescript
import { WebApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service } = WebApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
});
```

### Pod Security Standards

Kubernetes enforces three levels via Pod Security Admission:

| Level | What it blocks | When to use |
|-------|---------------|-------------|
| `privileged` | Nothing | System namespaces only |
| `baseline` | hostNetwork, hostPID, privileged containers | Development |
| `restricted` | Non-root, no capabilities, read-only root FS | Production |

Apply to a namespace:

```bash
kubectl label namespace prod pod-security.kubernetes.io/enforce=restricted
kubectl label namespace prod pod-security.kubernetes.io/warn=restricted
```

### Post-Synth Security Checks

chant catches security issues at build time:

| Check | What it detects |
|-------|----------------|
| WK8005 | Secrets exposed in environment variables |
| WK8006 | `latest` image tags (non-deterministic) |
| WK8041 | API keys or tokens in plain text |
| WK8042 | Hardcoded passwords in container env |
| WK8201 | Missing resource limits (CPU/memory) |
| WK8202 | Privileged containers |
| WK8203 | Host namespace sharing (hostPID/hostNetwork) |
| WK8204 | Writable root filesystem |
| WK8205 | Containers running as root |

## Image Security

### Pin Image Digests

Use image digests instead of tags for immutability:

```typescript
const { deployment } = WebApp({
  name: "api",
  image: "api@sha256:abc123def456...",
  port: 8080,
});
```

### Private Registry with imagePullSecrets

```typescript
import { Deployment, Secret } from "@intentius/chant-lexicon-k8s";

export const registryCreds = new Secret({
  metadata: { name: "registry-creds" },
  type: "kubernetes.io/dockerconfigjson",
  data: { ".dockerconfigjson": "${DOCKER_CONFIG_JSON}" },
});

export const deployment = new Deployment({
  spec: {
    template: {
      spec: {
        imagePullSecrets: [{ name: "registry-creds" }],
        containers: [{ name: "app", image: "private.registry.io/app:1.0" }],
      },
    },
  },
});
```

### Image Policy

Block unsigned or unscanned images with admission controllers:
- **Kyverno**: policy-based, Kubernetes-native
- **OPA/Gatekeeper**: Rego-based policies
- **Sigstore/Cosign**: image signature verification

## Network Policies

### Default Deny All

Start with deny-all and add explicit allows:

```typescript
import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

const ns = NamespaceEnv({
  name: "prod",
  defaultDenyIngress: true,
  defaultDenyEgress: true,
});
```

### Allow Specific Traffic

```typescript
import { NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";

const app = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  namespace: "prod",
  allowIngressFrom: [
    { podSelector: { "app.kubernetes.io/name": "gateway" } },
    { namespaceSelector: { "kubernetes.io/metadata.name": "monitoring" } },
  ],
  allowEgressTo: [
    { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
    { ipBlock: { cidr: "10.0.0.0/8" }, ports: [{ port: 443 }] },
  ],
});
```

### Allow DNS Egress

Most pods need DNS. Always allow egress to kube-dns:

```yaml
egress:
  - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: kube-system
    ports:
      - port: 53
        protocol: UDP
      - port: 53
        protocol: TCP
```

## Secrets Management

### External Secrets Operator

Sync secrets from external providers (AWS Secrets Manager, Vault, etc.):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets
    kind: ClusterSecretStore
  target:
    name: app-secrets
  data:
    - secretKey: db-password
      remoteRef:
        key: prod/db-password
```

### Sealed Secrets

Encrypt secrets for safe storage in Git:

```bash
kubeseal --format yaml < secret.yaml > sealed-secret.yaml
```

### Secret Rotation

Use the External Secrets Operator `refreshInterval` or Reloader to restart pods on secret changes:

```bash
kubectl annotate deployment api reloader.stakater.com/auto="true"
```

## RBAC Hardening

### Audit RBAC Permissions

```bash
# Check what a ServiceAccount can do
kubectl auth can-i --list --as=system:serviceaccount:prod:api-sa

# Check specific permission
kubectl auth can-i create pods --as=system:serviceaccount:prod:api-sa
```

### Avoid Cluster-Admin

Never bind `cluster-admin` to application ServiceAccounts. Use namespace-scoped Roles with minimal verbs:

```typescript
import { WorkerPool } from "@intentius/chant-lexicon-k8s";

const worker = WorkerPool({
  name: "processor",
  image: "processor:1.0",
  rbacRules: [
    { apiGroups: [""], resources: ["configmaps"], verbs: ["get"] },
  ],
});
```

### Service Account Token Projection

Disable auto-mounting of SA tokens when not needed:

```yaml
automountServiceAccountToken: false
```
