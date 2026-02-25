# Migration Lifecycle

Full end-to-end Flyway example: start a database, build config from chant, and apply V1 → V2 → V3 migrations with `environmentGroup` inheritance.

## Prerequisites

- [Bun](https://bun.sh)
- [Docker](https://docs.docker.com/get-docker/)
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Quick start

```bash
just up        # start dev + shadow PostgreSQL containers
just build     # generate flyway.toml from src/infra.ts
just info      # show migration status (all pending)
just migrate   # apply all migrations
just info      # show migration status (all applied)
```

## Step-by-step walkthrough

### 1. Start the databases

```bash
just up
```

This starts two PostgreSQL 16 containers:
- **dev-db** on port 5432 (`lifecycle_dev`)
- **shadow-db** on port 5433 (`lifecycle_shadow`)

### 2. Build the config

```bash
just build
```

Generates `flyway.toml` from `src/infra.ts`. The config defines three environments (dev, shadow, prod) using `environmentGroup` with shared settings deep-merged per environment.

### 3. Apply migrations incrementally

Apply only the first migration:

```bash
flyway -environment=devEnv -target=1 migrate
flyway -environment=devEnv info
```

Apply through V2:

```bash
flyway -environment=devEnv -target=2 migrate
```

Apply the rest:

```bash
flyway -environment=devEnv migrate
```

### 4. Reset workflow

Clean the dev database and re-apply all migrations:

```bash
just reset
```

### 5. Shadow environment

The shadow environment uses `provisioner = "clean"`, so Flyway automatically cleans before migrating — useful for verifying migrations from scratch:

```bash
flyway -environment=shadowEnv migrate
```

## Environment inheritance

`environmentGroup` deep-merges shared config into each environment:

```
shared
├── cleanDisabled: true
├── outOfOrder: false
├── placeholders: { appName, logLevel: "info", auditEnabled: "true" }
│
├─► devEnv      cleanDisabled → false, logLevel → "debug"
├─► shadowEnv   provisioner: "clean" (inherits everything else)
└─► prodEnv     validateOnMigrate: true, logLevel → "warn", env-var creds
```

- **Scalars** (string, number, boolean): per-env value replaces shared value
- **Objects** (placeholders, nested flyway): keys are merged
- **Arrays** (schemas, locations): per-env array replaces shared array entirely

## Cleanup

```bash
just down
```
