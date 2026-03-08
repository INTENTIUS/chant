# Multi-Container

A multi-container pod Helm chart with an API server and a Fluent Bit log-collector sidecar sharing an emptyDir volume.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the multi-container Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for a Deployment with two containers (api and log-collector), a shared emptyDir volume, health probes on the main container, and a ClusterIP Service.

## Source files

| File | Description |
|------|-------------|
| `src/chart.ts` | Defines Chart, Values, Deployment with main + sidecar containers, shared volume, and Service |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
bun install && bun run build && bun run lint
```

## Deploy

```bash
helm install multi-container .
```

## Teardown

```bash
helm uninstall multi-container
```

## Related examples

- [microservice-chart](../microservice-chart/) -- Single microservice with ingress and autoscaling
- [web-app-with-ingress](../web-app-with-ingress/) -- Web app with TLS ingress and HPA
- [stateful-service](../stateful-service/) -- StatefulSet with persistent storage

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
