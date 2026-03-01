# Composites Infrastructure

Infrastructure Helm chart composites — TLS ingress, namespace governance, DaemonSets, ExternalSecrets, and CRD lifecycle.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the composites-infrastructure example to my Kubernetes cluster.
> ```

## What this produces

- **Helm** (chart directory): Helm chart files (Chart.yaml, values.yaml, templates/) across 6 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/secure-ingress.ts` | `SecureIngress` | Ingress, Certificate |
| `src/namespace-env.ts` | `NamespaceEnv` | Namespace, ResourceQuota, LimitRange, NetworkPolicy |
| `src/daemon-set.ts` | `DaemonSet` | DaemonSet, ServiceAccount |
| `src/external-secret.ts` | `ExternalSecret` | ExternalSecret |
| `src/crd-lifecycle.ts` | `CrdLifecycle` | Job, ConfigMap, ServiceAccount, ClusterRole, ClusterRoleBinding |
| `src/library-chart.ts` | `LibraryChart` | *(library chart — no resources)* |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [Helm](https://helm.sh/docs/intro/install/) v3
- [ ] A Kubernetes cluster

**Local verification** (build, lint) requires only Node.js — no cluster needed.

## Local verification

```bash
npx chant build src --lexicon helm
npx chant lint src
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

- [composites-basic](../composites-basic/) — Basic Helm chart composites
- [composites-production](../composites-production/) — Production-hardened composites with security contexts and RBAC
