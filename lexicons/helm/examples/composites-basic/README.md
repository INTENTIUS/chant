# Composites Basic

Basic Helm chart composites — web application, microservice, stateful service, cron job, and worker patterns.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the composites-basic example to my Kubernetes cluster.
> ```

## What this produces

- **Helm** (chart directory): Helm chart files (Chart.yaml, values.yaml, templates/) across 5 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/web-app.ts` | `WebApp` | Deployment, Service, Ingress, HPA, ServiceAccount |
| `src/microservice.ts` | `Microservice` | Deployment, Service, ConfigMap, Ingress, HPA, PDB, ServiceAccount |
| `src/stateful-service.ts` | `StatefulService` | StatefulSet, Service |
| `src/cron-job.ts` | `CronJob` | CronJob |
| `src/worker.ts` | `Worker` | Deployment, HPA, PDB, ServiceAccount |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [Helm](https://helm.sh/docs/intro/install/) v3
- [ ] A Kubernetes cluster

**Local verification** (build, lint) requires only Node.js — no cluster needed.

## Local verification

```bash
npx chant build src --lexicon helm -o Chart.yaml
npx chant lint src
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

- [composites-production](../composites-production/) — Production-hardened composites with security contexts and RBAC
- [composites-infrastructure](../composites-infrastructure/) — Infrastructure composites: ingress, namespaces, CRDs

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
