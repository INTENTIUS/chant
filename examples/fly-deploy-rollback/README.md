# fly-deploy-rollback

You already run Fly Machines. This example wraps a **transactional rollback
boundary** around a Fly deploy, using a Sprite checkpoint as the commit point:

- **declarative infra-as-code** for your Machines (the `fly` lexicon — an `App`
  and a `Machine` you author in TypeScript, applied straight to the Machines
  API),
- a **Sprite sandbox** (Fly's stateful, checkpointable VM) whose checkpoint is a
  clean rewind point, and
- **checkpoint-as-compensation** — when a risky post-deploy step fails, restoring
  the checkpoint rewinds the whole sandbox to its known-good state in roughly the
  time a VM restore takes, instead of a hand-written undo.

The whole flow runs offline against the emulators (no Fly account, no cost), and
points at real Fly + real Sprites by changing two environment variables.

| Op | Phases | Point |
|----|--------|-------|
| `deploy` | Emulators → Sandbox → Checkpoint → Build → Deploy → Verify → Teardown | the happy path |
| `deploy-guarded` | Emulators → Sandbox → Checkpoint → Build → Deploy → RiskyChange, with `onFailure: Rollback` | the rollback climax |

It composes two other examples: [`local-fly`](../local-fly) (App + Machine →
flaps via `flyApply`) and [`sprites-agent-task`](../sprites-agent-task)
(checkpoint-as-compensation on a Sprite).

> **What the Sprite is (and isn't) for.** The deploy itself — `build:fly` then
> `flyApply` — is orchestrated by the Op, not run from inside the Sprite. The
> Sprite is a stateful sandbox that holds workspace state (here, a marker file
> standing in for whatever a real run accumulates — config written, artifacts
> built, migrations staged) and whose checkpoint is the rollback boundary. The
> point is the boundary: checkpoint = commit, restore = rollback.

## The infra to deploy

`src/infra.ts` is one Fly `App` and one `Machine` — the smallest complete
deploy, authored declaratively:

```ts
import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

// org_slug is required by the Machines API (real Fly rejects app creation
// without it). Fly.OrgSlug resolves from FLY_ORG at build time, default
// "personal".
const app = new App({ name: "fly-deploy-demo", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});
```

`build:fly` serializes these into the flaps create bodies `flyApply` POSTs: the
App into `POST /v1/apps { app_name, org_slug }`, the Machine into `POST
/v1/apps/fly-deploy-demo/machines { name, region, config }`. The serializer
stamps `managed-by: chant` into `config.metadata`, the ownership marker the
owned-only prune reads back.

## The phases

`ops/deploy.op.ts` lays the flow out as modeled activities, no raw shell:

- **Emulators** (offline only) — boot spritzer (the Sprites API fake) and
  mudflaps (the flaps fake) with `spritesUp` / `flapsUp`. Each emulator is booted
  only when its base-URL env var is set, so real mode boots no container.
- **Sandbox** — `spriteCreate` the Sprite sandbox, then `spriteExec` to seed its
  known-good state.
- **Checkpoint** — `spriteCheckpoint` the Sprite under the label `known-good`.
  This is the rewind target.
- **Build** — run `build:fly` to produce the serialized flaps plan.
- **Deploy** — `flyApply` the App + Machine, waiting each machine to `started`
  over `/wait`.
- **Verify** — GET the app's machines and assert one reached `started`.
- **Teardown** — destroy the Sprite, then remove whichever emulator containers
  were booted (none in real mode).

## Watch the bad deploy roll back

`ops/deploy-guarded.op.ts` is the same setup, then a risky follow-up step
(`./risky.sh`, run in the Sprite) corrupts the sandbox's state and exits
non-zero. The failing `RiskyChange` phase triggers the Op-level `onFailure`
`Rollback`, which restores the `known-good` checkpoint:

```ts
onFailure: [
  phase("Rollback", [
    spriteRestore({ id: "deploy-sandbox", comment: "known-good" }),
    // ...prove the rewind, then clean up
  ]),
],
```

A Sprite checkpoint is the transactional boundary, so recovery is a restore, not
a hand-written inverse action. The checkpoint `comment` and the Sprite `id` are
static strings the author writes, so nothing has to be threaded out of a prior
phase. `onFailure` phases run in reverse of the phases they compensate, so the
single `Rollback` phase holds the whole failure path in order: restore, prove
the rewind by reading the marker back, then clean up the Sprite and whichever
emulators were booted.

The run below shows `RiskyChange` failing, then `Rollback` restoring — the
`cat /work/state` step reports `known-good`, so the sandbox is back where it
started:

```
[phase] Deploy
  ✓ flyApply(planPath=dist/fly.json)   165ms
[phase] RiskyChange
  ✗ spriteExec(id=deploy-sandbox, cmd=./risky.sh)   5ms
    sprite deploy-sandbox exec "./risky.sh" exited 1: risky.sh: failed
[phase] Rollback
  ✓ spriteRestore(id=deploy-sandbox, comment=known-good)   3ms
  ✓ spriteExec(id=deploy-sandbox, cmd=cat /work/state)   3ms
    [outcome] state=known-good
  ✓ spriteDestroy(id=deploy-sandbox)   1ms
  ✓ flapsDown()   149ms
  ✓ spritesDown()   132ms
Op "deploy-guarded" failed after 1.4s
```

## What's real vs modeled offline

The deploy — `build:fly` and `flyApply` — is orchestrated by the Op in **both**
modes; it does not run inside the Sprite. What changes between modes is the
Sprite and flaps backends:

- **Offline mode** (spritzer + mudflaps containers, the default): the Sprite
  faithfully models the checkpointed sandbox and the restore-on-failure lifecycle
  — create, seed, checkpoint, corrupt, restore all behave as they do on real
  Sprites — while `flyApply` hits mudflaps, a stateful flaps fake. spritzer's
  `exec` is a scripted interpreter (it recognizes `echo`, `cat`, `rm`, and
  `./risky.sh`), not a real shell.
- **Real mode** (real Sprites + real Fly): the same Op, with the Sprite exec
  running as a real shell and `flyApply` hitting `api.machines.dev`.

So offline you get a real exercise of the checkpoint/restore boundary and a real
flaps apply against a stateful fake. Do not read either mode as the deploy
running inside the sandbox — the Sprite is the rollback boundary, not the deploy
host.

The `RiskyChange` step also differs by mode: offline, spritzer recognizes
`./risky.sh` and runs it to a scripted exit 1; on a real Sprite there is no such
file, so it fails as command-not-found (exit 127). The failure is different, but
either way it is a non-zero exit, so the `onFailure` `Rollback` fires and the
checkpoint restore is exercised the same. What the run demonstrates is the
compensation boundary, not that exact command.

## Run it offline

Requires only Docker. Point the two activity endpoints at the local emulators
and run the Op through the workspace CLI:

```bash
npm install

export FLY_FLAPS_BASE_URL=http://localhost:4280
export SPRITES_BASE_URL=http://localhost:4290

chant run deploy
chant run deploy-guarded
```

`deploy` exits `ok`. `deploy-guarded` exits non-zero on purpose: the
`RiskyChange` phase fails, the `onFailure` `Rollback` runs, and the Sprite is
back at its `known-good` checkpoint.

Add `--json` for machine-readable phase records (used by CI).

> In this dev checkout, run the Op through the workspace CLI —
> `npx tsx ../../packages/core/src/cli/main.ts run deploy` — rather than a
> globally linked `chant`, which double-loads modules here and can produce an
> empty plan. A normal install of `chant` does not have this quirk.

## Run it against real Fly + real Sprites

Drop the two emulator overrides and provide tokens. No code change:

```bash
unset FLY_FLAPS_BASE_URL       # flyApply falls through to real Fly (api.machines.dev)
unset SPRITES_BASE_URL         # the sprite steps fall through to real Sprites

export FLY_API_TOKEN=...       # a Fly deploy token
export SPRITES_API_TOKEN=...   # a Sprites token

chant run deploy
```

The fly and sprite activities resolve their endpoint the same way: an explicit
`endpoint` arg, then the env var, then the real API. The Op passes no `endpoint`
arg, so unsetting the two env vars is the whole switch. Each env var also gates
its emulator, so real mode boots no `spritzer`/`mudflaps` container — **no Docker
required** — and the phase list is just `Sandbox → Checkpoint → Build → Deploy →
Teardown`. The `Verify` step is a plain unauthenticated GET that runs only
against the local flaps (which needs no auth); against real Fly the Deploy step's
own `/wait` on `started` is the verification, and `Verify` is skipped.
