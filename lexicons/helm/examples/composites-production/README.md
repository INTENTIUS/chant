# Composites Production

Production-hardened Helm chart composites — security contexts, RBAC, monitoring, and secure cron jobs.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the composites-production example to my Kubernetes cluster.
> ```

## What this produces

- **Helm** (chart directory): Helm chart files (Chart.yaml, values.yaml, templates/) across 4 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/hardened-web-app.ts` | `HardenedWebApp` | Deployment, Service, Ingress, HPA, ServiceAccount (with security context) |
| `src/batch-migration.ts` | `BatchMigration` | Job, ServiceAccount, Role, RoleBinding |
| `src/monitored-api.ts` | `MonitoredApi` | Deployment, Service, ServiceAccount, ServiceMonitor, PrometheusRule |
| `src/cron-secured.ts` | `CronSecured` | CronJob, ServiceAccount (with security context) |

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
helm install composites-production .
```

## Teardown

```bash
helm uninstall composites-production
```

## Related examples

- [composites-basic](../composites-basic/) — Basic Helm chart composites
- [composites-infrastructure](../composites-infrastructure/) — Infrastructure composites: ingress, namespaces, CRDs
