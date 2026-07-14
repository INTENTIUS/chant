# sprites-build-sandbox

A disposable build sandbox on a [Sprite](https://sprites.dev) — Fly.io's
stateful, checkpointable sandbox. Warm a toolchain once, **checkpoint** it, then
build from staged source and read the artifact out — resetting to the warm
checkpoint so the next build starts fast.

The Sprite is the disposable box. The checkpoint is the **prepared pool**: a warm
toolchain you restore per build instead of re-installing. The filesystem
activities stage the source in and read the artifact out without shelling I/O
through `spriteExec`. Sprites are imperative and ephemeral, so this lives in
chant's Op/activity layer — no `build` phase, no serialized plan.

| Phase | Activity | Point |
|-------|----------|-------|
| Create | `spriteCreate` | spawn the sandbox |
| Warm | `spriteExec` | install the toolchain / prime caches (once) |
| Checkpoint | `spriteCheckpoint` | snapshot the warm toolchain — the prepared pool |
| Stage | `spriteWriteFile` | write the source in |
| Build | `spriteExec` | produce the artifact |
| Collect | `spriteReadFile` | read the artifact out |
| Reset | `spriteRestore` | rewind to the warm toolchain for the next build |
| Destroy | `spriteDestroy` | throw the box away |

## Run it

Boot the `spritzer` emulator, point at it, and run the Op — no Sprites account:

```bash
docker run -d --rm -p 4290:4290 --name spritzer ghcr.io/intentius/spritzer:0.4.1

npm install
export SPRITES_BASE_URL=http://localhost:4290
chant run build-sandbox

docker rm -f spritzer   # stop the emulator when done
```

## The prepared pool

Warming a toolchain (installing compilers, priming caches) is the slow part of a
build. `spriteCheckpoint` snapshots it once; `spriteRestore` rewinds to it in
seconds. In a real pool you keep the Sprite alive and restore the warm checkpoint
per build, so each build starts from the toolchain, not a cold install. This
example checkpoints, builds, then resets to the checkpoint to show the cycle.

## Real Sprites

Drop the `SPRITES_BASE_URL` override and set a token — the same Op:

```bash
unset SPRITES_BASE_URL
export SPRITES_API_TOKEN=...
chant run build-sandbox
```
