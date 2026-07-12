---
skill: chant-fly
description: Author, lint, and deploy Fly apps and machines from a chant project, applied straight to the Machines API
user-invocable: true
---

# Deploy to Fly Operational Playbook

## How chant and Fly relate

chant is a synthesis compiler: it compiles TypeScript in `src/` into a plan of Fly Machines API ("flaps") create requests, then reconciles that plan against a Fly org. Unlike the AWS or GCP lexicons, there is no external CLI to hand off to. `flyApply` speaks the Machines API directly, so the same code that builds the plan also applies it. There is no `flyctl` shell-out and no state file to store, lock, or keep in sync.

The source of truth is the TypeScript in `src/`. The serialized plan (a JSON object keyed by entity name, each value a `{ endpoint, method, body }` flaps request) is an intermediate artifact.

Your job as an agent:

- Use `chant build` for synthesis and lint (region, guest sizing, mounts, secret literals).
- Use `flyApply` (via the deploy Op, `chant run`) to reconcile the plan against the Machines API: create and update machines, wait each to `started`, and optionally prune what chant owns.

## The endpoint switch

One environment variable decides where the same code applies:

- `FLY_FLAPS_BASE_URL` unset, no token: point it at a local [mudflaps](https://github.com/intentius/mudflaps) emulator (offline, no Fly account, no bill). This is the loop CI runs.
- `FLY_FLAPS_BASE_URL` set to a real Fly org endpoint, plus `FLY_API_TOKEN`: the same plan deploys for real.

Resolution order for the endpoint is: an explicit `endpoint` arg, then `FLY_FLAPS_BASE_URL`, then the real-Fly default (`https://api.machines.dev`). The bearer token defaults to `FLY_API_TOKEN`; mudflaps ignores it.

Start from the runnable [`examples/local-fly`](../../examples/local-fly) loop:

```bash
cd examples/local-fly
chant run fly        # boots mudflaps, applies an App + Machine, waits for started, tears down
```

That Op runs the phases boot, build, apply, verify, and teardown against a local mudflaps container (Docker required). To target a real org, drop the local endpoint override and set `FLY_API_TOKEN`.

## Author an App and a Machine

Import resource types from `@intentius/chant-lexicon-fly`. They are generated from Fly's Machines API OpenAPI spec, so `MachineConfig` is typed all the way down through guest, services, mounts, and checks.

```ts
import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

export const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

export const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});
```

A machine that names no app is bound to the stack's sole app at apply time. You do not stamp the ownership marker yourself: the serializer writes `managed-by: chant` into each machine's `config.metadata`, and the owned-only prune reads it back.

The full resource set is `App`, `Machine`, `Volume`, `IPAddress`, `Certificate`, and `Secret`. Volumes, mounts, IPs, certificates, and apply-only secrets are covered in `chant-fly-patterns`.

## Build and lint

```bash
chant build src/
```

Build synthesizes the flaps plan and runs the lint rules before anything reaches the API:

| Rule | Catches |
|------|---------|
| FLY001 | `region` is not a real Fly region |
| FLY002 | Guest sizing (`cpu_kind` / `cpus` / `memory_mb`) is not a valid combination |
| FLY004 | A secret value written inline in machine config |
| FLY010 | A machine config with no `image` |
| FLY011 | A machine mount that references a `Volume` not declared in the stack (checked across files) |

Fix every reported violation before applying. Secret values belong in a `Secret` or a reference, never inline (FLY004).

## Apply with flyApply

`flyApply` reads the serialized plan and applies it to flaps in dependency order: app, then volumes, then machines, then IPs, certificates, and secrets. Per machine it does a GET-then-create or update, then waits.

- Create or update: POST the machine, then poll `GET .../wait` until it reaches `started` at its new `instance_id`. flaps caps its own long-poll at 60 seconds and answers 408 on expiry, so the client re-polls until its deadline (default 300 seconds).
- No-op on no drift: a re-apply of an unchanged machine (config structurally equal to live) does nothing.
- Leases: mutating an existing machine goes through the Machines API lease protocol. `flyApply` acquires a lease, echoes the nonce in the `fly-machine-lease-nonce` header on the mutation, and re-acquires and retries once if the lease was lost. Concurrent operators stay out of each other's way.

### Owned-only prune

Prune is off by default and destructive; turn it on to remove declared-then-removed resources.

- Machines prune owned-only: a machine is destroyed only if it carries the `managed-by: chant` marker and the plan no longer declares it. An unmarked (foreign) machine in the same app is never modified or deleted, so the applier is safe to point at an app that also holds resources you manage elsewhere.
- Volumes, IPs, certificates, and secrets have no metadata channel, so their ownership boundary is the app itself. See `chant-fly-patterns` for that app-boundary model before enabling prune on an app that mixes chant and non-chant resources.

## The deploy Op

The lexicon ships `flyDeploy`, a composite Op that wraps the boot, build, apply, verify, and teardown phases so `chant run` drives the whole loop as modeled activities with no raw shell.

```ts
// examples/local-fly/ops/fly.op.ts
import { flyDeploy } from "@intentius/chant-lexicon-fly";

export default flyDeploy({ app: "local-fly-demo" });
```

`chant run fly` boots mudflaps, builds the plan, applies the App and Machine, waits for the machine to reach `started`, and tears the emulator down. To deploy the same Op to a real org, drop the local endpoint override and set `FLY_API_TOKEN`.

## Teardown

`flyDelete` is the inverse of `flyApply`: it destroys the machines the plan declares (dependents first), then deletes the apps. It is idempotent, so an already-absent resource is a no-op.

## Quick reference

| Command | Description |
|---------|-------------|
| `chant build src/` | Synthesize the flaps plan and run lint (FLY001/FLY002/FLY004/FLY010/FLY011) |
| `chant run fly` | Run the deploy Op (boot, build, apply, verify, teardown) |
| `FLY_FLAPS_BASE_URL=...` | Point the same code at mudflaps or a real Fly org |
| `FLY_API_TOKEN=...` | Bearer token for a real Fly org (mudflaps ignores it) |

## Where to go next

- `chant-fly-patterns` covers volumes and mounts, IP assignments, certificates, apply-only secrets, and the app-boundary ownership model.
- `chant-fly-ops` covers operating a live app: waiting on stuck machines, lease conflicts, prune safety, and targeting a real org versus the emulator.
