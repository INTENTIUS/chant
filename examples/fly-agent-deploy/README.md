# fly-agent-deploy

You already run Fly Machines. This example puts three things together into one
flow:

- **declarative infra-as-code** for your Machines (the `fly` lexicon — an `App`
  and a `Machine` you author in TypeScript, applied straight to the Machines
  API),
- an **agent that deploys from inside an isolated Sprite** (Fly's stateful,
  checkpointable sandbox), and
- **checkpoint-backed rollback**, so a botched deploy rewinds the agent's whole
  workspace to a known-good checkpoint in roughly the time a VM restore takes.

The whole flow runs offline against the emulators (no Fly account, no cost), and
points at real Fly + real Sprites by changing two environment variables.

| Op | Phases | Point |
|----|--------|-------|
| `agent-deploy` | Emulators → Sandbox → Checkpoint → Build → Deploy → Verify → Teardown | the happy path |
| `agent-deploy-guarded` | Emulators → Sandbox → Checkpoint → Build → Deploy → RiskyChange, with `onFailure: Rollback` | the rollback climax |

This composes two other examples: [`local-fly`](../local-fly) (App + Machine →
flaps via `flyApply`) and [`sprites-agent-task`](../sprites-agent-task)
(checkpoint-as-compensation on a Sprite).

## The infra the agent deploys

`src/infra.ts` is one Fly `App` and one `Machine` — the smallest complete
deploy, authored declaratively:

```ts
const app = new App({ name: "fly-agent-demo" });

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
App into `POST /v1/apps { app_name }`, the Machine into `POST
/v1/apps/fly-agent-demo/machines { name, region, config }`. The serializer
stamps `managed-by: chant` into `config.metadata`, the ownership marker the
owned-only prune reads back.

## The phases

`ops/agent-deploy.op.ts` lays the flow out as modeled activities, no raw shell:

- **Emulators** — boot spritzer (the Sprites API fake) and mudflaps (the flaps
  fake) with `spritesUp` / `flapsUp`.
- **Sandbox** — `spriteCreate` the agent's workspace Sprite, then `spriteExec`
  to seed its known-good state.
- **Checkpoint** — `spriteCheckpoint` the Sprite under the label `known-good`.
  This is the rewind target.
- **Build** — run `build:fly` to produce the serialized flaps plan.
- **Deploy** — `flyApply` the App + Machine, waiting each machine to `started`
  over `/wait`.
- **Verify** — GET the app's machines and assert one reached `started`.
- **Teardown** — destroy the Sprite, then remove both emulator containers.

## Watch the bad deploy roll back

`ops/agent-deploy-guarded.op.ts` is the same setup, then the agent attempts a
risky change (`./risky.sh`) that corrupts its workspace and exits non-zero. The
failing `RiskyChange` phase triggers the Op-level `onFailure` `Rollback`, which
restores the `known-good` checkpoint:

```ts
onFailure: [
  phase("Rollback", [
    spriteRestore({ id: "deploy-agent", comment: "known-good" }),
    // ...prove the rewind, then clean up
  ]),
],
```

A Sprite checkpoint is the transactional boundary, so recovery is a restore, not
a hand-written inverse action. The checkpoint `comment` and the Sprite `id` are
static strings the author writes, so nothing has to be threaded out of a prior
phase. `onFailure` phases run in reverse of the phases they compensate, so the
single `Rollback` phase holds the whole failure path in order: restore, prove
the rewind by reading the marker back, then clean up the Sprite and both
containers.

The run below shows `RiskyChange` failing, then `Rollback` restoring — the
`cat /work/state` step reports `known-good`, so the sandbox is back where it
started:

```
  Deploy       flyApply         ok
  RiskyChange  spriteExec       fail    exited 1: risky.sh: failed
  Rollback     spriteRestore    ok
  Rollback     spriteExec       ok      outcome={ name: state, value: known-good }
  Rollback     spriteDestroy    ok
  Rollback     flapsDown        ok
  Rollback     spritesDown      ok
```

## What's real vs modeled offline

spritzer's `exec` is a scripted lifecycle interpreter (it recognizes `echo`,
`cat`, `rm`, and `./risky.sh`), not a real shell, so it cannot run real `chant`
inside the sandbox. That means the two modes differ in one specific way:

- **Real mode** (real Sprites + real Fly): the agent genuinely runs the deploy
  inside the Sprite. The `Sandbox` step is where the agent checks out and authors
  the project; the deploy happens in that workspace.
- **Offline mode** (spritzer + mudflaps containers, the default): the Sprite
  faithfully models the agent's checkpointed workspace and the restore-on-failure
  lifecycle — create, seed, checkpoint, corrupt, restore all behave as they do on
  real Sprites — while the Fly build and apply are orchestrated by the Op against
  mudflaps rather than run from inside the sandbox.

So offline you get a real exercise of the checkpoint/restore boundary and a real
flaps apply against a stateful fake, but the emulator does not run real `chant`
inside the Sprite. Do not read the offline run as the agent shelling out to
`chant` in the sandbox; that only happens in real mode.

## Run it offline

Requires only Docker. Point the two activity endpoints at the local emulators
and run the Op through the workspace CLI:

```bash
npm install

export FLY_FLAPS_BASE_URL=http://localhost:4280
export SPRITES_BASE_URL=http://localhost:4290

chant run agent-deploy
chant run agent-deploy-guarded
```

`agent-deploy` exits `ok`. `agent-deploy-guarded` exits non-zero on purpose: the
`RiskyChange` phase fails, the `onFailure` `Rollback` runs, and the Sprite is
back at its `known-good` checkpoint.

Add `--json` for machine-readable phase records (used by CI and the run above).

> In this dev checkout, run the Op through the workspace CLI —
> `npx tsx ../../packages/core/src/cli/main.ts run agent-deploy` — rather than a
> globally linked `chant`, which double-loads modules here and can produce an
> empty plan. A normal install of `chant` does not have this quirk.

## Run it against real Fly + real Sprites

Drop the two emulator overrides and provide tokens. No code change:

```bash
unset FLY_FLAPS_BASE_URL       # flyApply falls through to real Fly (api.machines.dev)
unset SPRITES_BASE_URL         # the sprite steps fall through to real Sprites

export FLY_API_TOKEN=...       # a Fly deploy token
export SPRITES_API_TOKEN=...   # a Sprites token

chant run agent-deploy
```

The fly and sprite activities resolve their endpoint the same way: an explicit
`endpoint` arg, then the env var, then the real API. The Op passes no `endpoint`
arg, so unsetting the two env vars is the whole switch. The `Verify` step is a
plain unauthenticated GET, so it runs only against the local flaps (which needs
no auth); against real Fly the Deploy step's own `/wait` on `started` is the
verification, and `Verify` is skipped.
