# Docker basic-app example

A minimal example using the Docker lexicon to define a Node.js app with a PostgreSQL database.

## What this produces

Running `npm run build` generates:

- `dist/docker-compose.yml` — the primary Compose file with `api`, `db` services and `pgdata` volume
- `dist/Dockerfile.api` — the multi-stage Dockerfile for the API service

## Files

- `src/compose.ts` — Service and Volume entities
- `src/api.ts` — Dockerfile entity for the API

## Usage

```bash
npm install
npm run build
# dist/docker-compose.yml and dist/Dockerfile.api are now ready
docker compose -f dist/docker-compose.yml up
```

## Prerequisites

- [chant CLI](https://intentius.io/chant) installed
- Docker and Docker Compose installed
