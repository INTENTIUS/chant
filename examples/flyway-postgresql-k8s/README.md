# Flyway + PostgreSQL on Kubernetes

Cross-lexicon example: deploy PostgreSQL as a Kubernetes StatefulSet on a local k3d cluster, then run Flyway migrations against it.

Demonstrates how `build()` handles multiple lexicons from a single `src/infra.ts` — the build system automatically partitions resources by lexicon namespace.

## Prerequisites

- [Bun](https://bun.sh)
- [just](https://github.com/casey/just) — command runner
- [Docker](https://docs.docker.com/get-docker/)
- [k3d](https://k3d.io/) (lightweight k3s in Docker)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Flyway CLI](https://documentation.red-gate.com/flyway/flyway-cli-and-api/download-and-installation)

## Quick Start

```bash
just run
```

This runs the full workflow: create cluster, build configs, deploy PostgreSQL, wait for readiness, and run migrations.

## Step by Step

### 1. Create a k3d cluster

```bash
just cluster-create
```

Creates a k3d cluster named `flyway-pg` with port 30432 mapped from the host to the cluster, so Flyway can reach PostgreSQL without `kubectl port-forward`.

### 2. Build

```bash
just build
```

Runs two `chant build` invocations:

- `chant build src --lexicon k8s -o k8s.yaml` — Namespace, StatefulSet, headless Service, NodePort Service
- `chant build src --lexicon flyway -o flyway.toml` — Flyway project, config, and local environment

### 3. Deploy PostgreSQL

```bash
just apply
just wait
```

Applies the K8s manifests and waits for the StatefulSet to be ready.

### 4. Run Migrations

```bash
just migrate
```

Runs Flyway migrations (V1–V3) against the database via the NodePort.

### 5. Tear Down

```bash
just teardown
```

Deletes the k3d cluster and all resources.

## How Cross-Lexicon Build Works

The `src/infra.ts` file imports resources from both `@intentius/chant-lexicon-k8s` and `@intentius/chant-lexicon-flyway`. Each resource carries its lexicon namespace internally:

- `Namespace`, `StatefulSet`, `Service` → `k8s`
- `FlywayProject`, `FlywayConfig`, `Environment` → `flyway`

When you run `chant build src --lexicon k8s`, only the K8s resources are serialized. The Flyway resources are silently skipped, and vice versa. The programmatic `build()` API accepts an array of serializers and returns a `Map<lexiconName, output>`.
