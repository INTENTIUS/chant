# temporal-self-hosted

Demonstrates using chant to declare a **self-hosted Temporal** setup as code — namespace configuration, search attributes, and schedules version-controlled alongside your application.

This is the right example if you run your own Temporal server (Docker or Kubernetes) rather than using Temporal Cloud. For the Temporal Cloud path, see [`temporal-crdb-deploy`](../temporal-crdb-deploy/).

---

## What chant generates

| Source | Output | Purpose |
|--------|--------|---------|
| `TemporalDevStack` in `src/stack.ts` | `dist/docker-compose.yml` | Starts Temporal server + UI locally |
| `TemporalDevStack` in `src/stack.ts` | `dist/temporal-helm-values.yaml` | Scaffold for production Helm install |
| `TemporalNamespace` (via `TemporalDevStack`) | `dist/temporal-setup.sh` | Creates the `my-app` namespace |
| `SearchAttribute` in `src/search-attrs.ts` | `dist/temporal-setup.sh` | Registers `JobType` and `Priority` attrs |
| `TemporalSchedule` in `src/schedules.ts` | `dist/schedules/daily-sync.ts` | Runnable TypeScript that creates the schedule |

One source tree, reproducible setup across every environment.

---

## Quickstart

```bash
npm run build   # generate dist/ artifacts
npm run start   # docker compose up — Temporal on :7233, UI on :8080
npm run setup   # create namespace + search attributes
```

Then register the schedule (once your worker is running):

```bash
npx tsx dist/schedules/daily-sync.ts
```

To stop the server:

```bash
npm run stop
```

---

## Connecting your worker

`chant.config.ts` declares the local worker profile. Import it in your `worker.ts` instead of reading raw env vars:

```ts
import { Worker, NativeConnection } from "@temporalio/worker";
import config from "./chant.config.ts";

const profile = config.temporal.profiles[config.temporal.defaultProfile ?? "local"];

const connection = await NativeConnection.connect({ address: profile.address });
const worker = await Worker.create({
  connection,
  namespace: profile.namespace,
  taskQueue: profile.taskQueue,
  workflowsPath: new URL("./workflows/index.ts", import.meta.url).pathname,
  activities,
});

await worker.run();
```

If `autoStart: true` is set (it is in this example), `chant run` will start `temporal server start-dev` automatically before the worker.

---

## Dev → production

The same `src/` tree generates both:

- **Dev:** `dist/docker-compose.yml` — single-container dev server via `temporal server start-dev`
- **Prod:** `dist/temporal-helm-values.yaml` — scaffold for `helm install temporal temporal/temporal -f dist/temporal-helm-values.yaml`

Namespace and search attribute setup (`dist/temporal-setup.sh`) works against both — it uses `$TEMPORAL_ADDRESS` (defaults to `localhost:7233`).

---

## Project structure

```
src/
  stack.ts          — TemporalDevStack composite (server + namespace)
  search-attrs.ts   — SearchAttribute declarations scoped to "my-app"
  schedules.ts      — TemporalSchedule for the daily-sync job
chant.config.ts     — local worker profile
```
