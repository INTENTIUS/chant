# Composites Infrastructure

Infrastructure Helm chart composites -- TLS ingress, namespace governance, DaemonSets, ExternalSecrets, and CRD lifecycle.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the composites-infrastructure Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for six infrastructure-level composites: secure ingress, namespace environments, daemon sets, external secrets, CRD lifecycle management, and a library chart.

## Source files

| File | Description |
|------|-------------|
| `src/secure-ingress.ts` | SecureIngress composite -- Ingress, Certificate |
| `src/namespace-env.ts` | NamespaceEnv composite -- Namespace, ResourceQuota, LimitRange, NetworkPolicy |
| `src/daemon-set.ts` | DaemonSet composite -- DaemonSet, ServiceAccount |
| `src/external-secret.ts` | ExternalSecret composite -- ExternalSecret |
| `src/crd-lifecycle.ts` | CrdLifecycle composite -- Job, ConfigMap, ServiceAccount, ClusterRole, ClusterRoleBinding |
| `src/library-chart.ts` | LibraryChart composite -- library chart (no resources) |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
npm install && npm run build && npm run lint
```

## Deploy

```bash
helm install composites-infrastructure .
```

## Teardown

```bash
helm uninstall composites-infrastructure
```

## Related examples

- [composites-basic](../composites-basic/) -- Basic composites: web app, microservice, stateful service, cron job, worker
- [composites-production](../composites-production/) -- Production-hardened composites with security contexts and RBAC
- [stateful-service](../stateful-service/) -- Redis StatefulSet with persistent storage

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
