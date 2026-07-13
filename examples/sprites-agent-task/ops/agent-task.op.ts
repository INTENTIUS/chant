import { Op, phase } from "@intentius/chant-lexicon-temporal";
import { spriteCreate, spriteCheckpoint, spriteWriteFile, spriteExec, spriteReadFile, spriteDestroy }
  from "@intentius/chant-lexicon-fly";

/**
 * Happy-path agent task on a Sprite ([sprites.dev](https://sprites.dev)):
 * create a sandbox, checkpoint it, stage an input file, run the work, read the
 * result, then destroy. Pure activity sequence — no `build` phase, no serialized
 * plan. `chant run agent-task`.
 *
 * The Stage/Collect phases use the filesystem activities (`spriteWriteFile` /
 * `spriteReadFile`) rather than shelling file I/O through `spriteExec` — an Op
 * stages its input and reads its output directly over the Sprites fs API.
 *
 * S3: the endpoint defaults to real Sprites; point at the in-process fake (or a
 * self-hosted emulator) by exporting `SPRITES_BASE_URL`. Real Sprites also needs
 * `SPRITES_API_TOKEN`.
 */
export default Op({
  name: "agent-task",
  overview: "Create a sprite, checkpoint, stage input, run, read output, destroy",
  taskQueue: "sprites",
  phases: [
    phase("Create", [spriteCreate({ name: "task-1", image: "sprites/base:latest" })]),
    phase("Checkpoint", [spriteCheckpoint({ id: "task-1", comment: "pre-run" })]),
    phase("Stage", [spriteWriteFile({ id: "task-1", path: "/work/input", content: "hello", mkdir: true })]),
    phase("Run", [spriteExec({ id: "task-1", cmd: "cat /work/input > /work/output" })]),
    phase("Collect", [spriteReadFile({ id: "task-1", path: "/work/output" })]),
    phase("Destroy", [spriteDestroy({ id: "task-1" })]),
  ],
});
