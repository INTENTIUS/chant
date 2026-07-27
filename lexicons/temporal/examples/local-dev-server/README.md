# Temporal local-dev-server example

A minimal local development stack: a single-container Temporal dev server, a
default namespace, a custom search attribute, and a nightly maintenance
schedule.

## What this produces

Running `npm run build` generates:

- `dist/docker-compose.yml` — the dev server (`temporal server start-dev`)
- `dist/temporal-setup.sh` — namespace and search attribute creation commands
- `dist/schedules/nightly-maintenance.ts` — runnable TypeScript that creates
  the schedule via the Temporal SDK client

## Files

- `src/stack.ts` — server + namespace, via the `TemporalDevStack` composite
- `src/search-attrs.ts` — a `JobType` search attribute
- `src/schedule.ts` — a nightly maintenance schedule

## Usage

```bash
npm install
npm run build
docker compose -f dist/docker-compose.yml up -d
bash dist/temporal-setup.sh
npx tsx dist/schedules/nightly-maintenance.ts
```

## Prerequisites

- [chant CLI](https://intentius.io/chant) installed
- Docker and Docker Compose installed
