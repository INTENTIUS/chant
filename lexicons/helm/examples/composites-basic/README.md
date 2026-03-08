# Composites Basic

Basic Helm chart composites -- web application, microservice, stateful service, cron job, and worker patterns.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the composites-basic Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for five composite patterns: web app, microservice, stateful service, cron job, and worker.

## Source files

| File | Description |
|------|-------------|
| `src/web-app.ts` | WebApp composite -- Deployment, Service, Ingress, HPA, ServiceAccount |
| `src/microservice.ts` | Microservice composite -- Deployment, Service, ConfigMap, Ingress, HPA, PDB, ServiceAccount |
| `src/stateful-service.ts` | StatefulService composite -- StatefulSet, Service |
| `src/cron-job.ts` | CronJob composite -- CronJob |
| `src/worker.ts` | Worker composite -- Deployment, HPA, PDB, ServiceAccount |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
bun install && bun run build && bun run lint
```

## Deploy

```bash
helm install composites-basic .
```

## Teardown

```bash
helm uninstall composites-basic
```

## Related examples

- [composites-production](../composites-production/) -- Production-hardened composites with security contexts and RBAC
- [composites-infrastructure](../composites-infrastructure/) -- Infrastructure composites: ingress, namespaces, CRDs
- [microservice-chart](../microservice-chart/) -- Single microservice chart using the HelmMicroservice composite

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
