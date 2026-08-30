/**
 * `run-agent`'s fly-lexicon adapter (#1942, epic #1564 phase 2) — the real
 * `SpriteActivities` implementation
 * (`@intentius/chant/components/verbs/run-agent`) over this lexicon's own
 * sprite lifecycle activities (`../op/activities/sprites.ts` +
 * `../op/activities/sprite-fs.ts`), and the `run-agent` capability built over
 * it. Registered through this lexicon's own `CapabilityPlugin`
 * (`./capability-plugin.ts`) the same way aws contributes `cfn-deploy` and
 * helm contributes `helm-upgrade` (docs/components/cloud-boundary) — core's
 * `createRunAgentCapability` (the sequencing logic: create-or-reuse,
 * checkpoint, stage, exec, collect, destroy/leave-alive, restore-by-comment)
 * stays cloud-agnostic in `@intentius/chant`, structurally independent of
 * this package; this module is the one piece with the hard dependency on the
 * real sprite wire protocol.
 *
 * **The exec-throw finding (pre-merge review of #1946, recorded on #1942).**
 * The real `spriteExec` (`../op/activities/sprites.ts`) throws on any
 * non-zero exit — by design, so a *scripted Op phase*
 * (`examples/sprites-agent-task/ops/guarded-task.op.ts`) fails and triggers
 * its `onFailure` compensation. But `run-agent`'s `RunAgentOutput.turn.status`
 * includes `"failed"` as a first-class, non-throwing result — an ordinary
 * failed agent turn (the model's diff didn't compile, its tests failed,
 * whatever the exit code means) is not an infrastructure failure and should
 * not by itself unwind the saga (checkpoint restore is for "the sprite
 * backend broke," not "the agent's output wasn't good"). Resolved here as
 * **option (a)** from the review comment: `exec()` below wraps the real
 * `spriteExec` in a try/catch and reclassifies a thrown non-zero-exit error
 * back into a resolved `{ stdout, stderr, exitCode }`
 * (`parseSpriteExecFailure`), so `SpriteActivities.exec` always resolves for
 * an ordinary command outcome — exactly the contract core's `run()`
 * (`packages/core/src/components/verbs/run-agent.ts`) assumes and relies on
 * (it deliberately has *no* try/catch of its own around `sprites.exec`). A
 * genuine transport/infra failure — the WebSocket erroring, connection
 * refused, an aborted signal — does not match the reclassification pattern
 * and still rejects, so core's saga-unwind path is preserved for *real*
 * failures.
 *
 * Option (b) — accept that ordinary failures throw, and drop `"failed"` from
 * `turn.status`'s reachable states — was rejected: it would make every
 * failed agent turn indistinguishable from a genuine sprite outage, forcing
 * a checkpoint-restore rollback for what is often just an unsuccessful
 * attempt, which is not what "the environment is the transaction" is meant
 * to protect against, and it would leave `RunAgentOutput.turn.status:
 * "failed"` a dead, unreachable branch of a type #1941 deliberately shipped
 * as reachable.
 *
 * **Fidelity note.** The real `spriteExec`'s thrown message carries only
 * `stderr || stdout` combined (see its own doc comment in `sprites.ts`), not
 * both streams separately — the reclassified result therefore folds that
 * combined text into `stderr` and leaves `stdout` empty on the failure path.
 * This is a known, documented loss versus a real non-throwing exec; recovering
 * full stream fidelity would mean reimplementing the WebSocket exec framing
 * here rather than reusing `spriteExec`, which is out of this issue's scope
 * (core's module doc calls adapting the existing activities "a thin wrapper,
 * not a rewrite").
 */

import type { Capability } from "@intentius/chant/components/capability";
import {
  createRunAgentCapability,
  type RunAgentInput,
  type RunAgentOutput,
  type SpriteActivities,
} from "@intentius/chant/components/verbs/run-agent";
import { spriteCreate, spriteCheckpoint, spriteExec, spriteRestore, spriteDestroy } from "../op/activities/sprites";
import { spriteWriteFile, spriteReadFile } from "../op/activities/sprite-fs";

/**
 * Parse the exit code + combined output text out of the real `spriteExec`'s
 * thrown message shape: `sprite <id> exec "<cmd>" exited <code>: <text>`
 * (see `../op/activities/sprites.ts`'s `spriteExec`). Returns `undefined` for
 * any other error shape — a genuine transport/infra failure the caller
 * should let propagate. Exported for direct unit testing of the
 * reclassification the module doc above describes as option (a).
 *
 * The leading `[\s\S]*` is greedy on purpose: `spriteExec`'s message echoes
 * the raw `cmd` verbatim before the real ` exited <code>: ` marker
 * (`exec "<cmd>" exited ...`), so a crafted command whose text itself
 * contains that exact substring must not be mistaken for the marker. A
 * greedy prefix backtracks from the end of the string, so it always anchors
 * to the *last* occurrence — the genuine marker `spriteExec` appended — never
 * a leftmost false match inside the echoed `cmd`.
 */
export function parseSpriteExecFailure(err: unknown): { exitCode: number; output: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const m = err.message.match(/^[\s\S]* exited (\d+): ([\s\S]*)$/);
  if (!m) return undefined;
  const exitCode = Number(m[1]);
  if (!Number.isFinite(exitCode)) return undefined;
  return { exitCode, output: m[2] };
}

/**
 * The real `SpriteActivities` implementation: a thin wrapper over this
 * lexicon's own sprite lifecycle + filesystem activities, matching
 * `@intentius/chant/components/verbs/run-agent`'s injectable seam exactly
 * (see that module's doc comment — "adapting them is a thin wrapper, not a
 * rewrite"). `exec()` is the one method that is not a bare pass-through — see
 * this module's doc comment for why.
 */
export function createFlySpriteActivities(): SpriteActivities {
  return {
    async create(args, signal) {
      return spriteCreate({ name: args.name, image: args.image }, signal);
    },
    async checkpoint(args, signal) {
      return spriteCheckpoint({ id: args.id, comment: args.comment }, signal);
    },
    async exec(args, signal) {
      try {
        return await spriteExec({ id: args.id, cmd: args.cmd, timeoutMs: args.timeoutMs }, signal);
      } catch (err) {
        const parsed = parseSpriteExecFailure(err);
        if (!parsed) throw err; // a genuine transport/infra failure — propagate it.
        return { stdout: "", stderr: parsed.output, exitCode: parsed.exitCode };
      }
    },
    async restore(args, signal) {
      await spriteRestore({ id: args.id, checkpoint: args.checkpoint, comment: args.comment }, signal);
    },
    async destroy(args, signal) {
      await spriteDestroy({ id: args.id }, signal);
    },
    async writeFile(args, signal) {
      await spriteWriteFile({ id: args.id, path: args.path, content: args.content, mkdir: args.mkdir }, signal);
    },
    async readFile(args, signal) {
      return spriteReadFile({ id: args.id, path: args.path }, signal);
    },
  };
}

/** Build the `run-agent` capability over the real fly sprite backend. */
export function createFlyRunAgentCapability(): Capability<RunAgentInput, RunAgentOutput> {
  return createRunAgentCapability(createFlySpriteActivities());
}

/** Default `run-agent` capability, backed by the real `SpriteActivities` adapter above — what `flyCapabilityPlugin` (./capability-plugin.ts) registers. */
export const flyRunAgentCapability: Capability<RunAgentInput, RunAgentOutput> = createFlyRunAgentCapability();
