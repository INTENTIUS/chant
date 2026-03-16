---
skill: chant-helm-security
description: Security best practices for Helm charts built with chant
user-invocable: true
---

# Helm Chart Security Patterns

## Pod Security Context

Always set pod-level security constraints. The `podSecurityContext` field applies to all containers in the pod.

```typescript
import { HelmWebApp } from "@intentius/chant-lexicon-helm";

const app = HelmWebApp({
  name: "secure-app",
  port: 3000,
  podSecurityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  },
});
```

**Lint rule WHM402** fires when `runAsNonRoot` is not set on any pod spec.

## Container Security Context

Set per-container restrictions to minimize attack surface:

```typescript
const app = HelmWebApp({
  name: "hardened-app",
  port: 8080,
  securityContext: {
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsUser: 1000,
  },
});
```

- **WHM403**: `readOnlyRootFilesystem` not set
- **WHM404**: `privileged: true` detected

If the application needs to write temporary files, mount a writable `emptyDir` volume at the specific path rather than disabling `readOnlyRootFilesystem`.

## Image Tagging

Never use `:latest` or omit the tag entirely. Use semver tags or digests.

```typescript
// Bad — WHM401 fires
HelmWebApp({ name: "app", imageTag: "latest", port: 3000 });

// Good — pinned semver
HelmWebApp({ name: "app", imageTag: "v2.4.1", port: 3000 });

// Best — pinned digest
HelmWebApp({ name: "app", imageTag: "sha256:abc123...", port: 3000 });
```

**Lint rule WHM401** fires when the image uses `:latest` or has no tag at all.

## Secret Management

Never inline secrets in `values.yaml`. Use External Secrets Operator or Sealed Secrets.

```typescript
import { HelmExternalSecret } from "@intentius/chant-lexicon-helm";

// External Secrets Operator — fetches secrets from a remote store at runtime
const secrets = HelmExternalSecret({
  name: "app-secrets",
  secretStoreName: "aws-secretsmanager",
  data: {
    DB_PASSWORD: "prod/db-password",
    API_KEY: "prod/api-key",
  },
});
```

**Lint rule WHM407** fires when a Secret resource contains inline `data` or `stringData` values. The fix is always to use an external secret provider.

### What NOT to do

```typescript
// Bad — WHM407 fires, secret value is in source control
new Secret({
  metadata: { name: "db-creds" },
  stringData: { password: "hunter2" },
});
```

## RBAC and ServiceAccount

Every workload should run under a dedicated ServiceAccount with minimal RBAC:

```typescript
const app = HelmMicroservice({
  name: "payment-api",
  port: 8080,
  serviceAccount: true, // creates a dedicated SA
});
```

When the workload needs API access, bind only the required verbs and resources:

```typescript
import { Role, RoleBinding } from "@intentius/chant-lexicon-k8s";

export const role = new Role({
  metadata: { name: include("payment-api.fullname") },
  rules: [{
    apiGroups: [""],
    resources: ["configmaps"],
    verbs: ["get", "watch"],
  }],
});
```

Avoid `ClusterRole` with wildcard resources or verbs. Prefer namespace-scoped `Role` bindings.

## Network Policies

Restrict pod-to-pod traffic to only what is required:

```typescript
import { NetworkPolicy } from "@intentius/chant-lexicon-k8s";

export const netpol = new NetworkPolicy({
  metadata: { name: "allow-frontend-to-api" },
  spec: {
    podSelector: { matchLabels: { app: "payment-api" } },
    policyTypes: ["Ingress"],
    ingress: [{
      from: [{ podSelector: { matchLabels: { app: "frontend" } } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    }],
  },
});
```

Start with a default-deny policy per namespace, then add allow rules for known traffic patterns.

## Resource Limits and Requests

Always set both requests and limits. Without them, a single pod can starve others.

```typescript
const app = HelmMicroservice({
  name: "api",
  port: 8080,
  // HelmMicroservice sets sensible defaults:
  //   requests: { cpu: "250m", memory: "128Mi" }
  //   limits:   { cpu: "500m", memory: "256Mi" }
});
```

**Lint rule WHM405** fires when a container spec is missing `cpu` or `memory` in resources. **WHM302** fires when resource limits are not set at all.

## Security Lint Rules Reference

| Rule   | What it checks                              | Severity |
|--------|---------------------------------------------|----------|
| WHM401 | Image uses `:latest` tag or no tag          | Warning  |
| WHM402 | `runAsNonRoot` not set on pod               | Warning  |
| WHM403 | `readOnlyRootFilesystem` not set            | Warning  |
| WHM404 | `privileged: true` on a container           | Error    |
| WHM405 | Missing cpu/memory in resource spec         | Warning  |
| WHM406 | CRD lifecycle limitation (no auto-upgrade)  | Info     |
| WHM407 | Secret with inline data in source           | Error    |

## Checklist

When reviewing or building a Helm chart, verify:

1. Pod runs as non-root with a numeric UID (`runAsNonRoot: true`, `runAsUser: 1000`)
2. Containers drop all capabilities (`capabilities: { drop: ["ALL"] }`)
3. Root filesystem is read-only (`readOnlyRootFilesystem: true`)
4. Privilege escalation is blocked (`allowPrivilegeEscalation: false`)
5. Images use pinned semver or digest tags, never `:latest`
6. Secrets come from an external provider, never inline
7. Each workload has a dedicated ServiceAccount
8. RBAC is namespace-scoped with minimal verbs
9. Network policies restrict ingress/egress to known peers
10. CPU and memory requests and limits are set on every container
