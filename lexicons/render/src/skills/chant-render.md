---
skill: chant-render
description: Author, lint, and deploy Render services, datastores, and env groups from a chant project, applied straight to the Render Public API
user-invocable: true
---

# Deploy to Render Operational Playbook

## How chant and Render relate

chant is a synthesis compiler: it compiles TypeScript in `src/` into a plan of Render Public API create requests, then reconciles that plan against a Render workspace. There is no external CLI to hand off to and no Blueprint (`render.yaml`) to keep in sync. `renderApply` speaks the Public API directly (`https://api.render.com/v1`), so the same code that builds the plan also applies it, and there is no state file to store, lock, or back up.

The source of truth is the TypeScript in `src/`. The serialized plan (a JSON object keyed by entity name, each value a `{ kind, entityType, endpoint, method, name, body }` request) is an intermediate artifact.

Your job as an agent:

- Use `chant build` for synthesis and lint (region, secret literals, cron schedule, runtime commands, source, free-plan scaling).
- Use `renderApply` (via the deploy Op, `chant run`) to reconcile the plan against the workspace: create or update each resource by name, wait each created service's deploy to `live`, and optionally prune what chant owns.

## Credentials and the workspace

Three environment variables:

- `RENDER_API_KEY` — a Render API key (Account Settings → API Keys). Required for every apply and read. Sent as `Authorization: Bearer`.
- `RENDER_OWNER_ID` — the workspace (team or personal) id, `tea-…` or `usr-…`. Every `ownerId` chant fills in defaults to it (`Render.OwnerId`). If unset, the applier reads `GET /owners` and uses the sole workspace the key can see; several visible workspaces is an error, never a guess.
- `RENDER_API_BASE_URL` — optional endpoint override (a local stand-in). Default `https://api.render.com/v1`.

Resolution order for the endpoint is: an explicit `endpoint` arg, then `RENDER_API_BASE_URL`, then the default.

Start from the runnable [`examples/getting-started`](../../lexicons/render/examples/getting-started) stack:

```bash
cd lexicons/render/examples/getting-started
export RENDER_API_KEY=rnd_…  RENDER_OWNER_ID=tea-…
npm run build        # chant build src --lexicon render -o dist/render.json
chant run render     # build → renderApply (creates the web service, waits for its deploy)
```

## Author a service and a database

Import resource types from `@intentius/chant-lexicon-render`. They are generated from Render's Public API OpenAPI spec, so `WebServiceDetails`, `Image`, `ServiceDisk`, and friends are typed all the way down, and every enum (`plan`, `region`, `runtime`) is a string-literal union.

```ts
import {
  WebService, WebServiceDetails, NativeEnvironmentDetails, EnvVar, GeneratedEnvVar, Postgres, Render,
} from "@intentius/chant-lexicon-render";

export const db = new Postgres({ name: "app-db", plan: "free", version: "16", region: Render.Region });

export const web = new WebService({
  name: "app-web",
  repo: "https://github.com/render-examples/express-hello-world",
  branch: "main",
  serviceDetails: new WebServiceDetails({
    runtime: "node",
    plan: "starter",
    region: Render.Region,
    envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
  }),
  envVars: [
    new EnvVar({ key: "DATABASE_URL", value: db.internalConnectionString }),
    new GeneratedEnvVar({ key: "SESSION_SECRET", generateValue: true }),
  ],
});
```

Each service type is its own class — `WebService`, `StaticSite`, `PrivateService`, `BackgroundWorker`, `CronJob` — with `serviceDetails` narrowed to that type's shape (`CronJobDetails` requires `schedule`; `StaticSiteDetails` has `publishPath` and `routes`). The other resources are `Postgres`, `KeyValue`, `EnvGroup`, `Project`, `Environment`, `Disk`, `CustomDomain`, `RegistryCredential`, and `Webhook`.

You do not stamp the ownership marker yourself: the serializer writes `CHANT_MANAGED_BY=chant` (plus `CHANT_STACK` / `CHANT_ENV`) into each service's and env group's `envVars`, and the owned-only prune reads it back.

### References between resources

Render assigns ids on create, so a Disk's `serviceId`, an Environment's `projectId`, or a service's `environmentId` cannot be a literal at build time. Pass the declared resource instead — `serviceId: web`, `projectId: project`, `environmentId: env` — and the applier substitutes the live id after the target exists. Attribute reads work the same way: `db.internalConnectionString`, `db.externalConnectionString`, `kv.internalConnectionString`, `web.id`, `web.dashboardUrl` resolve from the live resource (connection strings from the `/connection-info` endpoint).

## Build and lint

```bash
chant build src/
```

Build synthesizes the plan and runs the lint rules before anything reaches the API:

| Rule | Catches |
|------|---------|
| REN001 | `region` is not a Render region (frankfurt, oregon, ohio, singapore, virginia) |
| REN002 | A secret-looking env var (`*_PASSWORD`, `*_TOKEN`, `API_KEY`, …) with a literal value |
| REN003 | A `schedule` that is not a five-field cron expression |
| REN010 | A native-runtime service (node, python, …) with no `buildCommand`/`startCommand` |
| REN011 | A service with neither `repo` nor `image`, or `runtime: "image"` without an image |
| REN012 | A free-plan service with `numInstances > 1`, `autoscaling`, or a `disk` |

Fix every reported violation before applying. Secret values belong in `generateValue: true`, an `EnvGroup`, a resource attribute, or `process.env` — never a literal (REN002).

## Apply with renderApply

`renderApply` reads the plan and, in dependency order (projects → environments → env groups/datastores → services → disks/domains → webhooks):

1. Resolves `{ $ref }`, `{ $attr }`, and `{ $owner }` markers from what is already live.
2. Finds the existing resource by name (services also by type; environments by project; disks by service).
3. `POST`s a create when absent, or `PATCH`es the differing patchable fields when present. Service env vars are replaced through `PUT /services/{id}/env-vars`; a `generateValue` var keeps its live value rather than being regenerated. Env-group vars are reconciled per key.
4. Waits each **created** service's first deploy to `live` (`wait.deploys: false` to skip; `wait.deadlineMs` default 15 minutes) and throws on `build_failed`/`update_failed`/`canceled`.
5. With `prune: true`, deletes services and env groups that carry the marker for this stack but are no longer in the plan, and the disks and custom domains under an owned declared service that the plan no longer declares. Foreign resources (no marker) and other stacks' resources are never touched. Datastores, projects, environments, registry credentials, and webhooks are never pruned — they have no marker; remove them explicitly with `renderDelete`.

Returns the versioned apply envelope: `applied` (`created` / `updated` / `unchanged`, with the Render id as `physicalId`) and `pruned`.

## Read back with plan

`chant lifecycle plan` (via `describeResources`) lists what is live for every declared entity, with an ownership verdict: services and env groups are `owned` or `foreign` by the marker; disks and custom domains inherit their service's verdict; everything else is `unknown`, which the change set never escalates to a delete. Undeclared chant-owned services, env groups, disks, and domains surface as owned orphans, so a removed declaration shows up as a delete candidate before you prune.

## Teardown

`renderDelete` (or `renderDeploy({ teardown: true })`) deletes what the plan names in reverse order, looking each up by name; already-gone resources are reported `deleted: false`. Only what the plan declares is touched.
