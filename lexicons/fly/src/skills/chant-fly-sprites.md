---
skill: chant-temporal-sprites
description: Run an agent task in a Sprite as a chant Op — create, exec, checkpoint, restore, and destroy, with checkpoint-as-compensation
user-invocable: true
---

# Run an Agent Task in a Sprite

[Sprites](https://sprites.dev) are stateful, checkpointable sandboxes. Unlike a resource lexicon, a Sprite has no desired state to reconcile: it is a runtime-orchestration primitive, the same category as `k3dUp` or `httpCheck`. So the sprite lifecycle lives in chant's Op and activity layer, not in a declarative resource type.

This is the direct-API, Op-driven way to drive a Sprite: a structured, replayable activity sequence that a chant Op can checkpoint and roll back. It sits alongside the Sprites SDKs and CLI rather than replacing them, and it is not an MCP wrapper.

## The five activities

Each activity is a direct REST call over an injectable HTTP client, imported from `@intentius/chant-lexicon-fly` (Sprites are a Fly product, so they live in the fly lexicon alongside Machines):

| Activity | What it does |
|----------|--------------|
| `spriteCreate` | Create a sandbox. The caller-chosen `name` becomes the sprite `id` that every later activity keys on |
| `spriteExec` | Run a command inside the sprite. A non-zero exit throws, so the phase fails and any `onFailure` compensation runs |
| `spriteCheckpoint` | Snapshot the sprite under a caller-chosen `label` |
| `spriteRestore` | Rewind the sprite to a labeled checkpoint |
| `spriteDestroy` | Destroy the sprite (idempotent; an already-gone sprite is a no-op) |

The sprite `id` and the checkpoint `label` are static strings the Op author writes, so nothing has to be threaded from a prior phase's output.

## The happy path

Compose the activities into an Op as phases:

```ts
import { Op, phase } from "@intentius/chant-lexicon-temporal";
import { spriteCreate, spriteCheckpoint, spriteExec, spriteDestroy }
  from "@intentius/chant-lexicon-fly";

export default Op({
  name: "agent-task",
  overview: "Create a sprite, checkpoint, run the task, verify, destroy",
  taskQueue: "sprites",
  phases: [
    phase("Create", [spriteCreate({ name: "task-1", image: "sprites/base:latest" })]),
    phase("Checkpoint", [spriteCheckpoint({ id: "task-1", label: "pre-run" })]),
    phase("Run", [spriteExec({ id: "task-1", cmd: "echo hello > /work/output" })]),
    phase("Verify", [spriteExec({ id: "task-1", cmd: "cat /work/output" })]),
    phase("Destroy", [spriteDestroy({ id: "task-1" })]),
  ],
});
```

There is no `build` phase and no serialized plan: the activities run in sequence. Run it with `chant run agent-task`.

## Checkpoint-as-compensation

The reason Sprites map onto chant Ops so well is rollback. A VM checkpoint is a fast transactional boundary. An Op checkpoints before a risky phase and, on failure, restores the labeled checkpoint instead of running an inverse action. The environment itself is the transaction, so there is nothing to unwind by hand.

Put the `spriteRestore` in the Op's `onFailure`, referencing the same label the `Checkpoint` phase wrote:

```ts
import { Op, phase } from "@intentius/chant-lexicon-temporal";
import { spriteCreate, spriteCheckpoint, spriteExec, spriteDestroy, spriteRestore }
  from "@intentius/chant-lexicon-fly";

export default Op({
  name: "guarded-task",
  overview: "Checkpoint, run a risky step, restore on failure",
  taskQueue: "sprites",
  phases: [
    phase("Create",     [spriteCreate({ name: "task-1" })]),
    phase("Checkpoint", [spriteCheckpoint({ id: "task-1", label: "pre-run" })]),
    phase("Run",        [spriteExec({ id: "task-1", cmd: "./risky.sh" })]),
    phase("Destroy",    [spriteDestroy({ id: "task-1" })]),
  ],
  onFailure: [
    phase("Restore", [spriteRestore({ id: "task-1", checkpoint: "pre-run" })]),
  ],
});
```

When the `Run` phase's command exits non-zero, `spriteExec` throws, the phase fails, and the Op-level `onFailure` `Restore` rewinds the sprite to its `pre-run` checkpoint.

## Targeting the emulator or real Sprites

The activities resolve their endpoint in this order: an explicit `endpoint` arg, then `SPRITES_BASE_URL`, then the real Sprites base. The same Op targets an emulator or real Sprites with no code change. The default `fetch` client adds `Authorization: Bearer ${SPRITES_API_TOKEN}` when a token is set; the emulator ignores it.

```bash
# Point at a self-hosted or in-process emulator.
export SPRITES_BASE_URL=http://127.0.0.1:9000
chant run agent-task
```

```bash
# Real Sprites: drop the override and set a token.
unset SPRITES_BASE_URL
export SPRITES_API_TOKEN=...
chant run agent-task
```

The offline, Docker-free emulator that CI runs against is `createSpritesFake()` in this lexicon (`src/op/activities/sprites-fake.ts`); the activities and their tests live alongside it in `sprites.ts`. The local-emulator flow is the one to develop against.

The real Sprites REST surface is provisional (S6, tracked in #766): the endpoint constants may still move to match the official API. The activity input and output contracts (the `Args` and `Result` shapes shown above) are the stable interface the Ops and the emulator are written against, so build your Ops on those.

## Beyond the five: filesystem, config, and keep-alive

The same lexicon ships more Sprite primitives, all imported from `@intentius/chant-lexicon-fly` and resolved by `loadActivities(["fly"])`:

| Family | Activities | Use |
|--------|-----------|-----|
| Filesystem (#848) | `spriteWriteFile` / `spriteReadFile` / `spriteListDir` / `spriteRemove` | stage an input file and read a result out without shelling `spriteExec` + `cat` |
| Config reconcile (#849) | `spriteApplyNetworkPolicy` / `spriteApplyServices` | reconcile a Sprite's egress allowlist and background services against typed config (validated before any HTTP; a whole-object replace for policy, create-or-update by name for services) |
| Keep-alive (#847) | `spriteTaskCreate` / `spriteTaskRefresh` / `spriteTaskRelease` | hold a Sprite active for a session so it will not pause; a session past the 1-hour task cap refreshes on an interval |

These are still runtime-orchestration primitives, not declarable resources — a Sprite has no desired-state create body to reconcile.

## Where it fits

The runnable starter is [`examples/sprites-agent-task`](../../examples/sprites-agent-task), which ships both Ops above. Run `chant run agent-task` for the happy path and `chant run guarded-task` to watch the checkpoint-as-compensation rollback. `guarded-task` exits non-zero on purpose: the `Run` phase fails, the `onFailure` `Restore` runs, and the sprite is back at `pre-run`.

[`examples/sprites-managed-agent-worker`](../../examples/sprites-managed-agent-worker) composes the config and keep-alive families into one [Claude Managed Agents](https://docs.sprites.dev/integrations/claude-managed-agents/) session: create → egress policy → keep-alive task → env-contract file → runner-as-service → run → release → destroy, with an `onFailure` that frees the hold and tears the Sprite down.
