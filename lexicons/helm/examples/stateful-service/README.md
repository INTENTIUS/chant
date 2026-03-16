# Stateful Service

A Redis StatefulSet Helm chart with persistent storage, headless service, and rolling updates.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the stateful-service Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for a 3-replica Redis StatefulSet with volumeClaimTemplates, a headless Service for stable DNS, liveness/readiness probes, pod and container security contexts, and a rolling update strategy.

## Source files

| File | Description |
|------|-------------|
| `src/chart.ts` | Defines Chart, Values, headless Service, StatefulSet with persistent volume claims, health probes, and security contexts |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
bun install && bun run build && bun run lint
```

## Deploy

```bash
helm install stateful-service .
```

## Teardown

```bash
helm uninstall stateful-service
```

## Related examples

- [composites-basic](../composites-basic/) -- Basic composites including a StatefulService pattern
- [composites-infrastructure](../composites-infrastructure/) -- Infrastructure composites with namespace governance
- [cron-job](../cron-job/) -- Scheduled CronJob with backup task

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
