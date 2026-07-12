import { Op, phase, spriteCreate, spriteCheckpoint, spriteExec, spriteDestroy, spriteRestore }
  from "@intentius/chant-lexicon-temporal";

/**
 * Checkpoint-as-compensation (S5): checkpoint before a risky step and, on
 * failure, `spriteRestore` the checkpoint instead of unwinding with an inverse
 * action. A fast VM checkpoint is the transactional boundary — the environment
 * itself is the transaction. The checkpoint carries a `comment` ("pre-run"); the
 * `onFailure` `Restore` matches on that comment (newest wins) rather than a
 * server-assigned version id. `./risky.sh` corrupts the workspace and exits
 * non-zero, so the `Run` phase fails and the sprite is rewound to `pre-run`.
 */
export default Op({
  name: "guarded-task",
  overview: "Checkpoint, run a risky step, restore on failure",
  taskQueue: "sprites",
  phases: [
    phase("Create",     [spriteCreate({ name: "task-1" })]),
    phase("Checkpoint", [spriteCheckpoint({ id: "task-1", comment: "pre-run" })]),
    phase("Run",        [spriteExec({ id: "task-1", cmd: "./risky.sh" })]),
    phase("Destroy",    [spriteDestroy({ id: "task-1" })]),
  ],
  onFailure: [
    phase("Restore", [spriteRestore({ id: "task-1", comment: "pre-run" })]),
  ],
});
