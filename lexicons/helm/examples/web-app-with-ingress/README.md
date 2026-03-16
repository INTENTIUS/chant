# Web App with Ingress

A web application Helm chart using the HelmWebApp composite with TLS-ready ingress, autoscaling, and security contexts.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the web-app-with-ingress Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for a frontend web app with Deployment, Service, ServiceAccount, TLS-ready Ingress, and HPA autoscaling, plus liveness/readiness probes and a rolling update strategy.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Uses HelmWebApp composite to define a frontend app with ingress, autoscaling, health probes, security contexts, and rolling update strategy |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
bun install && bun run build && bun run lint
```

## Deploy

```bash
helm install frontend .
```

## Teardown

```bash
helm uninstall frontend
```

## Related examples

- [microservice-chart](../microservice-chart/) -- Microservice using HelmMicroservice composite with PDB
- [multi-container](../multi-container/) -- Multi-container pod with sidecar
- [composites-production](../composites-production/) -- Production-hardened composites with RBAC and monitoring

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
