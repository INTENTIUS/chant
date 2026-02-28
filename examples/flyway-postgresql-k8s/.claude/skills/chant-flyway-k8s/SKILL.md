---
skill: chant-flyway-k8s
description: Deploy PostgreSQL on Kubernetes and run Flyway migrations using chant
user-invocable: true
---

# Flyway + PostgreSQL on Kubernetes

This project deploys PostgreSQL as a Kubernetes StatefulSet on a local k3d
cluster, then runs Flyway database migrations against it. It demonstrates
chant's cross-lexicon capability: a single `src/infra.ts` imports from both
the K8s and Flyway lexicons.

See also the lexicon skills `chant-k8s` and `chant-flyway` for composite
reference and operational playbooks.

## Project layout

- `src/infra.ts` — all resources in a single file (K8s + Flyway)
- `src/chant.config.json` — lint configuration
- `sql/migrations/` — Flyway SQL migration files (V1–V3)
- `k8s.yaml` — generated K8s manifests (do not edit)
- `flyway.toml` — generated Flyway config (do not edit)

## Local verification (no cluster required)

Run from the example directory (`examples/flyway-postgresql-k8s/`):

```bash
bun run build              # generates k8s.yaml (4 K8s resources) + flyway.toml
bun run lint               # zero errors expected
```

Run tests from the repo root:

```bash
bun test examples/flyway-postgresql-k8s/
```

## Deploy workflow

### Prerequisites

- Docker running
- k3d installed
- kubectl installed
- Flyway CLI installed

### Full automated deploy

```bash
bun run run                # cluster-create → build → apply → wait → migrate
```

### Step by step

```bash
bun run cluster-create     # k3d cluster "flyway-pg" with port 30432 mapped
bun run build              # chant build for k8s + flyway
bun run apply              # kubectl apply -f k8s.yaml
bun run wait               # wait for StatefulSet readiness
bun run migrate            # flyway migrate -environment=local
bun run info               # flyway info (verify migration state)
```

## Verify

```bash
bun run info               # shows migration history
kubectl get pods -n flyway-pg
kubectl get svc -n flyway-pg
```

## Teardown

```bash
bun run teardown           # deletes the k3d cluster and all resources
```

## Troubleshooting

- StatefulSet stuck in Pending → check Docker is running and k3d cluster is healthy: `k3d cluster list`
- Flyway connection refused → ensure port 30432 is mapped: `docker ps` should show port mapping
- Migration checksum mismatch → `flyway repair -environment=local`
