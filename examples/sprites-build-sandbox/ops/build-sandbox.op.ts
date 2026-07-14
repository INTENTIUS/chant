import { Op, phase } from "@intentius/chant-lexicon-temporal";
import {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteWriteFile,
  spriteReadFile,
  spriteRestore,
  spriteDestroy,
} from "@intentius/chant-lexicon-fly";

/**
 * A disposable build sandbox on a Sprite ([sprites.dev](https://sprites.dev)):
 * warm a toolchain once, checkpoint it, then build from staged source and collect
 * the artifact — resetting to the warm checkpoint so the next build starts fast.
 * `chant run build-sandbox`.
 *
 * The Sprite is the disposable box; the checkpoint is the **prepared pool** — a
 * warm toolchain you restore per build instead of re-installing. The filesystem
 * activities stage the source in and read the artifact out without shelling I/O
 * through `spriteExec`.
 *
 * S3: the endpoint defaults to real Sprites; point at the emulator with
 * `SPRITES_BASE_URL`. Real Sprites also needs `SPRITES_API_TOKEN`.
 */
export default Op({
  name: "build-sandbox",
  overview: "Warm a toolchain, checkpoint it, build from staged source, collect the artifact, reset",
  taskQueue: "sprites",
  phases: [
    phase("Create", [spriteCreate({ name: "builder", image: "sprites/base:latest" })]),
    // Warm the toolchain once (install deps, prime caches). Here, a marker file.
    phase("Warm", [spriteExec({ id: "builder", cmd: "echo ready > /opt/toolchain" })]),
    // Checkpoint the warm toolchain — the prepared pool a build restores to.
    phase("Checkpoint", [spriteCheckpoint({ id: "builder", comment: "toolchain-ready" })]),
    // Stage the source, build it, and read the artifact back out.
    phase("Stage", [spriteWriteFile({ id: "builder", path: "/src/main.txt", content: "hello", mkdir: true })]),
    phase("Build", [spriteExec({ id: "builder", cmd: "cat /src/main.txt > /out/artifact.txt" })]),
    phase("Collect", [spriteReadFile({ id: "builder", path: "/out/artifact.txt" })]),
    // Rewind to the warm toolchain — the next build starts from the prepared pool,
    // not a cold install. In a real pool you keep the Sprite and restore per build.
    phase("Reset", [spriteRestore({ id: "builder", comment: "toolchain-ready" })]),
    phase("Destroy", [spriteDestroy({ id: "builder" })]),
  ],
});
