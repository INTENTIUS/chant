# CronJob

A database backup CronJob Helm chart with configurable schedule, concurrency policy, and security contexts.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon helm`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm chart lifecycle: build, lint, package, deploy, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the cron-job Helm chart.
> ```

## What this produces

Generates Chart.yaml, values.yaml, and templates/ for a CronJob that runs pg_dump on a configurable schedule with retry backoff, history limits, and pod/container security contexts.

## Source files

| File | Description |
|------|-------------|
| `src/chart.ts` | Defines the Chart, Values, and CronJob resource with schedule, concurrency policy, backoff limits, and security contexts |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Helm](https://helm.sh/docs/intro/install/)

## Build

```bash
npm install && npm run build && npm run lint
```

## Deploy

```bash
helm install cron-job .
```

## Teardown

```bash
helm uninstall cron-job
```

## Related examples

- [composites-basic](../composites-basic/) -- Basic composites including a CronJob pattern
- [composites-production](../composites-production/) -- Production composites with a secured CronJob variant
- [stateful-service](../stateful-service/) -- StatefulSet with persistent storage

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
