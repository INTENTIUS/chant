# @intentius/chant-lexicon-render

The Render lexicon for [chant](https://intentius.io/chant/). Declare Render web services, static sites, private services, background workers, cron jobs, Postgres and Key Value datastores, env groups, projects, environments, disks, custom domains, registry credentials, and webhooks as typed TypeScript and apply them straight to the Render Public API.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-render
```

## What it does

chant is a type system for operations: you describe infrastructure as typed TypeScript, and each lexicon turns those declarations into real provider API calls. This one covers [Render](https://render.com).

The resource types are generated from Render's own [Public API OpenAPI spec](https://api-docs.render.com/v1.0/openapi/render-public-api-1.json), so they track the real API and give you full editor autocomplete — every `plan`, `region`, and `runtime` is a string-literal union, and `serviceDetails` is typed per service type. A build step lints them, and `renderApply` reconciles them against a workspace over `https://api.render.com/v1` directly.

It fits two kinds of user: teams running on Render who want their infrastructure as typed, reviewed, reconciled code rather than a `render.yaml` Blueprint or dashboard clicks, and platform engineers who already manage AWS, GCP, Kubernetes, or Fly through chant and want Render in the same model.

## Author infrastructure as typed code

```ts
import {
  WebService, WebServiceDetails, NativeEnvironmentDetails, EnvVar, GeneratedEnvVar, Postgres, Render,
} from "@intentius/chant-lexicon-render";

export const db = new Postgres({ name: "app-db", plan: "free", version: "16", region: Render.Region });

export const web = new WebService({
  name: "app-web",
  repo: "https://github.com/render-examples/express-hello-world",
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

Each service type is its own class (`WebService`, `StaticSite`, `PrivateService`, `BackgroundWorker`, `CronJob`) with `serviceDetails` narrowed to that type's shape. Cross-resource ids accept the declared resource — `serviceId: web`, `projectId: project`, `environmentId: env` — and attribute reads like `db.internalConnectionString` resolve from the live resource at apply time. `Render.OwnerId` and `Render.Region` are pseudo-parameters resolved from `RENDER_OWNER_ID` / `RENDER_REGION`.

## Apply without a state file

`renderApply` speaks the Public API directly. There is no CLI shell-out, no Blueprint sync, and no state file to store, lock, or keep in sync. It reconciles what you declared against what is actually running:

- Finds each resource by name (services also by type), `POST`s a create when absent or `PATCH`es the differing fields when present, and replaces service env vars through `PUT /services/{id}/env-vars` — keeping a `generateValue` var's live value rather than regenerating it.
- Resolves references in dependency order: projects → environments → env groups and datastores → services → disks and custom domains → webhooks.
- Waits each created service's first deploy to `live`, and fails on `build_failed` / `update_failed`.
- Prunes only what chant owns. Every service and env group chant creates carries a `CHANT_MANAGED_BY=chant` env-var marker (plus `CHANT_STACK` / `CHANT_ENV`); a resource without it — or belonging to another stack — is never modified or deleted by `prune`, so the applier is safe to point at a workspace that also holds resources you manage elsewhere. Datastores and the other marker-less kinds are never pruned.

Auth is `RENDER_API_KEY`; the workspace is `RENDER_OWNER_ID`, or the sole workspace the key can see. `RENDER_API_BASE_URL` (or an `endpoint` arg) redirects the whole loop to a local stand-in.

## Catch mistakes at build time

Lint rules run during `chant build`, before anything reaches the API:

- `region` must be a Render region (REN001).
- A secret-looking env var may not carry a literal value — use `generateValue`, an `EnvGroup`, a resource attribute, or `process.env` (REN002).
- A cron job `schedule` must be a five-field cron expression (REN003).
- A native-runtime service must set `buildCommand` and `startCommand` (REN010); every service needs a `repo` or an `image` (REN011); a free-plan service cannot scale or mount a disk (REN012).

## Read back and plan

`describeResources` lists what is live for every declared entity with an ownership verdict — `owned` / `foreign` for services and env groups by the marker, `unknown` for the rest — and surfaces undeclared chant-marked services and env groups as owned orphans, so `chant lifecycle plan` shows the delete before you prune.

## The deploy Op

`renderDeploy()` returns a `build → renderApply [→ verify] [→ teardown]` Op, and the runnable [`examples/getting-started`](examples/getting-started) starter wires it up:

```bash
cd lexicons/render/examples/getting-started
export RENDER_API_KEY=… RENDER_OWNER_ID=…
chant run render
```

## Compared to a Blueprint (`render.yaml`)

|              | Blueprint                                    | This lexicon                                                    |
| ------------ | -------------------------------------------- | --------------------------------------------------------------- |
| **Language** | YAML, validated at sync time                 | TypeScript, types generated from the Public API spec, linted at build |
| **Apply**    | Render syncs from the repo on push           | `renderApply` from anywhere with an API key — CI, a laptop, an agent |
| **State**    | Render's own; resources tied to the Blueprint | None; reconciles by name from live state + the ownership marker |
| **References** | `fromDatabase` / `fromService` YAML keys   | `db.internalConnectionString`, `serviceId: web` — typed, checked |

## Agent skill

The agent-facing entry point is the `chant-render` skill: a short operational playbook that walks an agent through authoring a service and a database, linting with `chant build`, and reconciling over the Public API with `renderApply`, including credentials and the workspace. It ships with `chant-render-patterns` (env groups, projects and environments, disks, custom domains, image-backed and cron services, and the ownership model). The skill sources live in [`src/skills/`](src/skills/).
