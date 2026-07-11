import { Op, phase, spriteCreate, spriteCheckpoint, spriteExec, spriteDestroy }
  from "@intentius/chant-lexicon-temporal";

/**
 * Happy-path agent task on a Sprite ([sprites.dev](https://sprites.dev)):
 * create a sandbox, checkpoint it, run the work, verify, then destroy. Pure
 * activity sequence — no `build` phase, no serialized plan. `chant run agent-task`.
 *
 * S3: the endpoint defaults to real Sprites; point at the in-process fake (or a
 * self-hosted emulator) by exporting `SPRITES_BASE_URL`. Real Sprites also needs
 * `SPRITES_API_TOKEN`.
 */
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
