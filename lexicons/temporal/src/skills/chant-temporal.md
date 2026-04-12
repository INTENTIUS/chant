---
skill: chant-temporal
description: Build and manage Temporal server deployment, namespace provisioning, and schedule registration from a chant project
user-invocable: true
---

# Temporal Operational Playbook

## How chant and Temporal relate

chant is a **synthesis compiler** — it compiles TypeScript resource declarations into deployment artifacts. `chant build` does not start Temporal or register anything; synthesis is pure and deterministic. Your job as an agent is to bridge synthesis and deployment:

- Use **chant** for: build, lint, diff (local config comparison)
- Use **docker compose / kubectl / temporal CLI** for: starting the server, applying configs, and all runtime operations

The source of truth for Temporal configuration is the TypeScript in `src/`. The generated artifacts in `dist/` are intermediate outputs.

## Resources and their outputs

| Resource | Emits |
|---|---|
| `TemporalServer` | `docker-compose.yml` (primary) + `temporal-helm-values.yaml` |
| `TemporalNamespace` | `temporal-setup.sh` (namespace create commands) |
| `SearchAttribute` | `temporal-setup.sh` (search-attribute create commands) |
| `TemporalSchedule` | `schedules/<id>.ts` (SDK schedule creation script) |

## Build and validate

### Build the project

```bash
chant build src/ --output dist/
```

Options:
- `--watch` — rebuild on source changes
- `--format json` — not applicable (Temporal outputs are YAML/shell/TypeScript)

### Lint the source

```bash
chant lint src/
```

## Start the Temporal server

### Local dev (generated docker-compose.yml)

```bash
# Start the dev server
docker compose up -d

# Verify it's running
temporal operator cluster health
```

The dev server runs as a single container (`temporal server start-dev`). The Web UI is available at `http://localhost:8080`.

### Temporal Cloud

No server to start. Configure your worker profile in `chant.config.ts`:

```ts
import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

export default {
  lexicons: ["temporal"],
  temporal: {
    profiles: {
      cloud: {
        address: "myns.a2dd6.tmprl.cloud:7233",
        namespace: "myns.a2dd6",
        taskQueue: "my-deploy",
        tls: true,
        apiKey: { env: "TEMPORAL_API_KEY" },
      },
    },
    defaultProfile: "cloud",
  } satisfies TemporalChantConfig,
};
```

## Provision namespaces and search attributes

After the server is ready, run the generated setup script:

```bash
bash dist/temporal-setup.sh
```

This creates namespaces and registers search attributes using the `temporal` CLI. The `TEMPORAL_ADDRESS` env var overrides the default `localhost:7233`:

```bash
TEMPORAL_ADDRESS=myns.a2dd6.tmprl.cloud:7233 bash dist/temporal-setup.sh
```

Verify:

```bash
temporal operator namespace describe --namespace default
temporal operator search-attribute list --namespace default
```

## Deploy with Helm

```bash
helm repo add temporal https://go.temporal.io/server/helm-charts
helm repo update
helm install temporal temporal/temporal -f dist/temporal-helm-values.yaml
```

Wait for all pods:

```bash
kubectl get pods -l app.kubernetes.io/name=temporal -w
```

## Register schedules

Each `TemporalSchedule` resource generates a standalone TypeScript runner:

```bash
# Set connection env vars
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default

# Run the generated schedule creation script
npx tsx dist/schedules/daily-backup.ts
```

Verify the schedule was created:

```bash
temporal schedule list --namespace default
temporal schedule describe --schedule-id daily-backup --namespace default
```

## Key resource types

| Resource | Purpose |
|---|---|
| `TemporalServer` | Server deployment config (dev vs full mode) |
| `TemporalNamespace` | Namespace with retention policy |
| `SearchAttribute` | Custom workflow search field |
| `TemporalSchedule` | Recurring workflow trigger |

## Common patterns

### Minimal local dev stack

```ts
import { TemporalServer, TemporalNamespace } from "@intentius/chant-lexicon-temporal";

export const server = new TemporalServer({ mode: "dev" });
export const ns = new TemporalNamespace({ name: "default", retention: "7d" });
```

### Production namespace with search attributes

```ts
import { TemporalNamespace, SearchAttribute } from "@intentius/chant-lexicon-temporal";

export const ns = new TemporalNamespace({
  name: "prod-deploy",
  retention: "30d",
  description: "Production deployment workflows",
});

export const gcpProject = new SearchAttribute({
  name: "GcpProject",
  type: "Text",
  namespace: "prod-deploy",
});

export const environment = new SearchAttribute({
  name: "Environment",
  type: "Keyword",
  namespace: "prod-deploy",
});
```

### Recurring backup schedule

```ts
import { TemporalSchedule } from "@intentius/chant-lexicon-temporal";

export const backupSchedule = new TemporalSchedule({
  scheduleId: "daily-backup",
  spec: {
    cronExpressions: ["0 3 * * *"],
  },
  action: {
    workflowType: "backupWorkflow",
    taskQueue: "backup-queue",
  },
  policies: {
    overlap: "Skip",
    pauseOnFailure: true,
  },
});
```
