# Microservice Chart

A production-ready microservice Helm chart using the HelmMicroservice composite with ingress, autoscaling, and PodDisruptionBudget.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the microservice-chart Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for a payment-api microservice with Deployment, Service, ServiceAccount, ConfigMap, Ingress, HPA, and PodDisruptionBudget.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Uses HelmMicroservice composite to define a payment-api with health probes, security contexts, node selector, rolling update strategy, ingress, autoscaling, and PDB |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
npm install && npm run build && npm run lint
```

## Deploy

```bash
helm install payment-api .
```

## Teardown

```bash
helm uninstall payment-api
```

## Related examples

- [web-app-with-ingress](../web-app-with-ingress/) -- Web app using HelmWebApp composite with TLS ingress
- [composites-basic](../composites-basic/) -- Basic composites including a Microservice pattern
- [multi-container](../multi-container/) -- Multi-container pod with sidecar

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
