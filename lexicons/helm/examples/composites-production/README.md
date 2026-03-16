# Composites Production

Production-hardened Helm chart composites -- security contexts, RBAC, monitoring, and secure cron jobs.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the composites-production Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for four production-grade composites: hardened web app, batch migration with RBAC, monitored API with Prometheus, and secured cron job.

## Source files

| File | Description |
|------|-------------|
| `src/hardened-web-app.ts` | HardenedWebApp composite -- Deployment, Service, Ingress, HPA, ServiceAccount with security context |
| `src/batch-migration.ts` | BatchMigration composite -- Job, ServiceAccount, Role, RoleBinding |
| `src/monitored-api.ts` | MonitoredApi composite -- Deployment, Service, ServiceAccount, ServiceMonitor, PrometheusRule |
| `src/cron-secured.ts` | CronSecured composite -- CronJob, ServiceAccount with security context |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
bun install && bun run build && bun run lint
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

- [composites-basic](../composites-basic/) -- Basic composites: web app, microservice, stateful service, cron job, worker
- [composites-infrastructure](../composites-infrastructure/) -- Infrastructure composites: ingress, namespaces, CRDs
- [web-app-with-ingress](../web-app-with-ingress/) -- Web app with TLS ingress and autoscaling

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
