---
skill: chant-render-patterns
description: Render patterns in chant — env groups, projects and environments, disks, custom domains, image-backed and cron services, and the ownership model
user-invocable: true
---

# Render Patterns

Companion to `chant-render`. Each pattern is a fragment you can drop into `src/`.

## Env groups shared across services

An `EnvGroup` holds env vars (and secret files) many services share. Link services with `serviceIds`, passing the declared resources:

```ts
import { EnvGroup, EnvVar, GeneratedEnvVar, WebService, BackgroundWorker, WebServiceDetails, BackgroundWorkerDetails } from "@intentius/chant-lexicon-render";

export const web = new WebService({ name: "web", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "docker" }) });
export const worker = new BackgroundWorker({ name: "worker", repo: REPO, serviceDetails: new BackgroundWorkerDetails({ runtime: "docker" }) });

export const shared = new EnvGroup({
  name: "shared",
  envVars: [
    new EnvVar({ key: "LOG_LEVEL", value: "info" }),
    new GeneratedEnvVar({ key: "SIGNING_KEY", generateValue: true }),
  ],
  serviceIds: [web, worker],
});
```

The applier links each service after both exist (`POST /env-groups/{id}/services/{serviceId}`) and reconciles group vars per key on later runs. Env groups carry the ownership marker, so they are prunable.

## Projects and environments

A `Project` groups `Environment`s; a service, datastore, or env group joins one through `environmentId`. Reference the declared environment and the applier fills the id:

```ts
import { Project, ProjectEnvironment, Environment, Postgres } from "@intentius/chant-lexicon-render";

export const project = new Project({ name: "shop", environments: [new ProjectEnvironment({ name: "production" })] });
export const prod = new Environment({ name: "production", projectId: project, protectedStatus: "protected" });
export const db = new Postgres({ name: "shop-db", plan: "basic_1gb", version: "16", environmentId: prod });
```

`Project.environments` creates environments with the project (Render requires at least one); a separate `Environment` resource is how you reference one from other resources and PATCH it later. Reconciling by name means the environment created inline and the one declared separately are the same live object.

## Persistent disks

Two ways. Inline, as part of the service (created with it):

```ts
serviceDetails: new WebServiceDetails({ runtime: "docker", plan: "starter", disk: new ServiceDisk({ name: "data", mountPath: "/data", sizeGB: 10 }) })
```

Or as a standalone `Disk` attached to a declared service, which can be resized independently:

```ts
export const data = new Disk({ name: "data", sizeGB: 10, mountPath: "/data", serviceId: web });
```

Disks are only valid on web services, private services, and background workers (the `serviceId` type says so), and never on the free plan (REN012).

## Custom domains

```ts
export const apex = new CustomDomain({ name: "example.com", serviceId: web });
export const www = new CustomDomain({ name: "www.example.com", serviceId: web });
```

The domain is created under the service (`POST /services/{id}/custom-domains`); DNS verification stays a manual step in Render's dashboard or via the `/verify` endpoint. `describeResources` reports the domain's `verificationStatus` as its status.

## Image-backed services

```ts
import { WebService, WebServiceDetails, Image, RegistryCredential } from "@intentius/chant-lexicon-render";

export const cred = new RegistryCredential({ name: "ghcr", registry: "GITHUB", username: "me", authToken: process.env.GHCR_TOKEN! });
export const api = new WebService({
  name: "api",
  image: new Image({ imagePath: "ghcr.io/acme/api:1.4.2", registryCredentialId: cred }),
  serviceDetails: new WebServiceDetails({ runtime: "image", plan: "starter" }),
});
```

`Image.ownerId` is filled from the service's owner. `registryCredentialId` accepts the declared credential. Deploying a new tag is a change to `imagePath` → a PATCH → Render redeploys.

## Cron jobs

```ts
export const nightly = new CronJob({
  name: "nightly-report",
  repo: REPO,
  serviceDetails: new CronJobDetails({
    runtime: "python",
    schedule: "0 3 * * *",
    envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "pip install -r requirements.txt", startCommand: "python report.py" }),
  }),
});
```

`schedule` is a five-field cron expression (REN003); Render accepts no `@daily`-style macros.

## Static sites

```ts
export const site = new StaticSite({
  name: "docs",
  repo: REPO,
  serviceDetails: new StaticSiteDetails({
    buildCommand: "npm ci && npm run build",
    publishPath: "dist",
    routes: [new Route({ type: "rewrite", source: "/*", destination: "/index.html" })],
    headers: [new Header({ path: "/*", name: "X-Frame-Options", value: "DENY" })],
  }),
});
```

## The ownership model

Render has no tags or labels. chant's marker is an env var:

- **Services and env groups** carry `CHANT_MANAGED_BY=chant`, `CHANT_STACK=<stack>`, `CHANT_ENV=<env>` in their env vars. That is the primary marker: `describeResources` answers `owned` / `foreign` from it, and `prune: true` deletes only marked resources of the current stack that the plan no longer declares. A service someone created in the dashboard is `foreign` and is never modified or deleted by prune — but it *is* adopted by name if you declare it (a PATCH brings it to the declared shape and stamps the marker).
- **Everything else** (Postgres, KeyValue, Project, Environment, Disk, CustomDomain, RegistryCredential, Webhook) has no marker channel; its verdict is `unknown` and it is never pruned. Remove one by dropping it from the plan and running `renderDelete` on the old plan, or by hand.

The marker keys are visible in the service's environment. That is deliberate — it is the same information a Kubernetes label or an AWS tag carries, in the only durable key/value store Render exposes.
