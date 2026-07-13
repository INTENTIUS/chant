# sprites-agent-task

Two Ops that drive a [Sprite](https://sprites.dev) — Fly.io's stateful,
checkpointable sandbox — as a pure sequence of activities. Sprites are
imperative and ephemeral (create, exec, checkpoint, restore, destroy), so they
live in chant's Op/activity layer rather than a declarative resource lexicon.
There is no `build` phase, no serialized plan, and no `dist/`.

| Op | Phases | Point |
|----|--------|-------|
| `agent-task` | Create → Checkpoint → Stage → Run → Collect → Destroy | the happy path |
| `guarded-task` | Create → Checkpoint → Run → Destroy, with `onFailure: Restore` | checkpoint-as-compensation |

`agent-task` stages its input and reads its result with the filesystem
activities (`spriteWriteFile` / `spriteReadFile`) instead of shelling file I/O
through `spriteExec`. An Op writes a file into the sandbox, runs the work, and
reads the output back directly over the Sprites fs API.

## Checkpoint-as-compensation

The reason Sprites map onto chant Ops so well is rollback. A VM checkpoint is a
fast transactional boundary: an Op checkpoints before a risky phase and, on
failure, restores the tagged checkpoint instead of running an inverse action.
The environment itself is the transaction, so there is nothing to unwind by
hand. `guarded-task` runs `./risky.sh` (which corrupts the workspace and exits
non-zero); the failing `Run` phase triggers the Op-level `onFailure` `Restore`,
which rewinds the sprite to its `pre-run` checkpoint.

```ts
onFailure: [
  phase("Restore", [spriteRestore({ id: "task-1", comment: "pre-run" })]),
],
```

The checkpoint `comment` and the sprite `id` are static strings the Op author
writes, so nothing has to be threaded from a prior phase's output. `spriteRestore`
lists the sprite's checkpoints and rewinds to the newest one carrying that
comment; pass an explicit `checkpoint` version id instead to target one exactly.

## Run it

```bash
npm install

chant run agent-task
chant run guarded-task
```

`guarded-task` exits non-zero: the `Run` phase fails on purpose, the `onFailure`
`Restore` phase runs, and the sprite is back at the `pre-run` checkpoint.

## Targeting the fake or real Sprites

The same Ops target the in-process emulator or real Sprites with no code change
(S3). The activities resolve their endpoint as: an explicit `endpoint` arg, then
`SPRITES_BASE_URL`, then the real Sprites API.

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

The offline, Docker-free version of the emulator used by CI is
`createSpritesFake()` in the fly lexicon
(`lexicons/fly/src/op/activities/sprites-fake.ts`); the sprite activities and
their tests live alongside it in `sprites.ts` / `sprites-fs.ts` /
`sprites.integration.test.ts`.
