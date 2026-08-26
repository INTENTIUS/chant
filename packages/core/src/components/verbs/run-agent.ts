/**
 * `run-agent` — phase 1 design: capability schema + registry entry (#1941,
 * epic #1564 "run-agent as a bounded, attested component capability").
 *
 * **Decided (2026-08-25, maintainer comment on #1564).** The agent turn
 * executes on a fly [Sprite](https://sprites.dev), via chant's own sprite
 * lifecycle activities (`lexicons/fly/src/op/activities/sprites.ts` —
 * `spriteCreate`/`spriteCheckpoint`/`spriteExec`/`spriteRestore`/`spriteDestroy`,
 * plus the filesystem activities in `sprite-fs.ts` —
 * `spriteWriteFile`/`spriteReadFile`), **not** fountain's hosted `fountainRun`
 * path (`lexicons/fountain/src/op/activities/fountain-run.ts`): `fountainRun`
 * polls a fountain-managed `Conversation` to a terminal HTTP status and gives
 * chant no checkpoint control, but the epic's compensation story needs chant
 * to own the sprite directly. Compensation is checkpoint-before/restore-on-unwind
 * — "the environment is the transaction," no hand-written inverse action — the
 * same pattern `examples/sprites-agent-task/ops/guarded-task.op.ts` already
 * demonstrates at the Op layer. The offline path is `sprites-fake`/
 * `sprites-emulator` (spritzer), the same `SPRITES_BASE_URL` endpoint-override
 * story `sprites.ts` documents.
 *
 * **Input tracks fountain's `Agent` surface as it stands today**
 * (`lexicons/fountain/src/spec/fountain-openapi.snapshot.json`): `agent` is
 * resolved the same way `fountainRun`'s `resolveAgentId` resolves a name/id
 * against `/api/agents`; `task` is `PromptRequest`-shaped (`prompt` +
 * optional `images`, `ImageInput`'s exact shape). The output's `turn` facts
 * track `Turn`'s shape (`status`/`exit_code`/`started_at`/`ended_at`), even
 * though the turn runs on a chant-owned sprite rather than a fountain-managed
 * `Sandbox` — fountain supplies the *declarative* facts (which model, which
 * runtime, which egress policy via `Environment`), chant drives the
 * *imperative* execution. Revisit only if `BinaryBourbon/fountain#586` (the
 * `Estate` proposal) lands a breaking shape.
 *
 * **Placement.** Registered the same way `docker-build` is (./build.ts) — a
 * factory over an injectable executor seam (`SpriteActivities` below, the
 * `run-agent` analogue of ./cloud-executor.ts's `CloudExecutor`) — so core
 * carries the typed schema without a hard package dependency on
 * `@intentius/chant-lexicon-fly` (core stays cloud/vendor-agnostic in its
 * dependency graph, see docs/components/cloud-boundary; the same reasoning
 * that keeps the AWS leaves in `@intentius/chant-lexicon-aws` rather than
 * here). Unlike the AWS leaves, there is today no fly-lexicon capability
 * plugin for this verb to live in instead, and `run-agent` is a foundational,
 * pipeline-level primitive in the same vein as `docker-build` or
 * `wrangler-deploy` (./wrangler.ts) rather than a swappable per-cloud leaf —
 * the same tradeoff `wrangler.ts`'s module doc weighs for the Cloudflare
 * Workers verbs. Revisit if a broader agent-execution lexicon ever owns this
 * seam instead.
 *
 * **Phase 1 scope.** This module ships the typed contract only — `run`/
 * `rollback` are typed stubs (`CapabilityNotImplementedError`), per
 * ../capability.ts's own module doc ("Verb implementations live under
 * `./verbs/*` as typed stubs — no cloud calls, no side effects. Cloud
 * implementations are a later phase"). `rollbackPolicy: "native"` is declared
 * now (so COMP003, ../lint/rules/comp/comp003-mutating-no-rollback.ts, never
 * requires a `noRollback` opt-out for this verb once it composes into a
 * component) even though the paired `rollback` body is not yet real — the
 * *policy* is a phase 1 design commitment, the *implementation* is #1942's
 * ("Sprite lifecycle wiring — checkpoint-as-compensation + offline
 * fake/emulator path"). #1943 ("Provenance + attestation") owns the
 * `provenance.sourceRef` transcript-hash basis and verify-gate interop; #1944
 * owns the conformance/contract test suite (saga-unwind restore, COMP003
 * refusal) beyond this module's own unit tests.
 *
 * **Open questions left for #1942/#1943 (not decided by the 2026-08-25
 * comment):**
 *  - Runtime invocation inside the sprite — does the sprite image already
 *    carry the `claude`/`codex`/`gemini`/`opencode` CLI, or does `run()` need
 *    a setup step?
 *  - Output artifact encoding — individual `spriteReadFile` calls per changed
 *    path vs. one tarred snapshot folded into a `BuildArchiveManifest` entry
 *    (./build-archive.ts) the way `docker-build`'s `image` entry works.
 *  - Interrupted turns — how a `Turn.status: "interrupted"`-equivalent
 *    (deadline hit mid-run) surfaces in `RunAgentOutput.turn.status` vs.
 *    throwing (which would trigger the saga rollback path in ../driver.ts).
 *  - Transcript hash basis — exactly what bytes `provenance.sourceRef` hashes
 *    and whether the raw transcript is retained anywhere beyond the attested
 *    digest.
 */

import type { Capability } from "../capability";
import { CapabilityNotImplementedError } from "../capability";
import type { ProvenanceLink } from "./reproducibility";

// ── fountain surface excerpts this input/output tracks ──────────────────────

/** fountain's `ImageInput` (`PromptRequest.images[]`) — a base64-encoded image attached to a prompt. */
export interface RunAgentImageInput {
  /** Base64-encoded image bytes. */
  data: string;
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** fountain's `Agent.runtime` — the CLI the turn runs inside the sprite. */
export type RunAgentRuntime = "claude" | "codex" | "gemini" | "opencode";

// ── run-agent ─────────────────────────────────────────────────────────────

export interface RunAgentInput {
  /** fountain `Agent` name or id — resolved like `fountainRun`'s `resolveAgentId` (`lexicons/fountain/src/op/activities/fountain-run.ts`) against `/api/agents`. */
  agent: string;
  task: {
    prompt: string;
    /** fountain's `ImageInput` shape (`PromptRequest.images`). */
    images?: RunAgentImageInput[];
  };
  workspace: {
    /** Reuse an existing sprite (warm start). Omit to create a fresh sprite for this turn. */
    spriteName?: string;
    /** Base image for a freshly created sprite. Ignored when reusing `spriteName`. */
    image?: string;
    /** Checkpoint comment for the pre-run checkpoint `rollback()` restores to. Default: `"pre-run"`. */
    checkpointComment?: string;
  };
  /** Folded into the output's `provenance.sourceRef` alongside the transcript hash — same field name `DockerBuildInput.sourceRef` already uses (#614, ./build.ts). Omit when unknown; no `provenance` basis beyond the transcript hash in that case. */
  sourceRef?: string;
}

/** Mirrors fountain's `Turn` shape (`status`/`exit_code`/`started_at`/`ended_at`), even though the turn itself runs on a chant-owned sprite rather than a fountain-managed `Sandbox`. */
export interface RunAgentTurn {
  status: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** One artifact file the turn produced, content-addressed the same way a `BuildArchiveEntry` is (./build-archive.ts). */
export interface RunAgentArtifactFile {
  path: string;
  digest: string;
}

export interface RunAgentOutput {
  /** The sprite this turn ran on — the same id `rollback()` restores. */
  spriteId: string;
  /** The pre-run checkpoint id — the same id `rollback()` restores to. */
  checkpointId: string;
  turn: RunAgentTurn;
  artifacts: {
    files: RunAgentArtifactFile[];
    /** Unified diff of the workspace against its pre-run checkpoint, when applicable. */
    diff?: string;
  };
  /** #614's shape (./reproducibility.ts) — `sourceRef` is the prompt/transcript hash; exact basis is #1943's decision (see this module's doc comment). */
  provenance: ProvenanceLink;
}

// ── SpriteActivities: the injectable sprite-lifecycle seam ─────────────────

/**
 * The subset of `lexicons/fly/src/op/activities/sprites.ts` +
 * `sprite-fs.ts`'s activity contracts `run-agent` needs, restated
 * structurally here (rather than imported) so this module carries no hard
 * package dependency on `@intentius/chant-lexicon-fly` — the same
 * injectable-seam shape ./cloud-executor.ts's `CloudExecutor`/`DockerClient`
 * use to keep ./build.ts's `docker-build` testable with no real `docker`
 * daemon. A real implementation (#1942) is structurally compatible with
 * `spriteCreate`/`spriteCheckpoint`/`spriteExec`/`spriteRestore`/
 * `spriteDestroy`/`spriteWriteFile`/`spriteReadFile`'s existing signatures —
 * adapting them is a thin wrapper, not a rewrite.
 */
export interface SpriteActivities {
  create(
    args: { name: string; image?: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; url: string }>;
  checkpoint(
    args: { id: string; comment?: string },
    signal?: AbortSignal,
  ): Promise<{ checkpointId: string }>;
  exec(
    args: { id: string; cmd: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  restore(
    args: { id: string; checkpoint?: string; comment?: string },
    signal?: AbortSignal,
  ): Promise<void>;
  destroy(args: { id: string }, signal?: AbortSignal): Promise<void>;
  writeFile(
    args: { id: string; path: string; content: string; mkdir?: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
  readFile(
    args: { id: string; path: string },
    signal?: AbortSignal,
  ): Promise<{ content: string }>;
}

/**
 * Thrown by `defaultSpriteActivities()`'s methods — phase 1 (#1941) ships the
 * typed seam only; wiring it to the real sprite lifecycle activities (or the
 * offline `sprites-fake`/`sprites-emulator` path) is #1942's deliverable.
 * Distinguishes "the seam exists but is not wired yet" from
 * `CapabilityNotImplementedError` (which `run`/`rollback` throw below) so a
 * caller that supplies its own `SpriteActivities` never hits this class.
 */
export class SpriteActivitiesNotWiredError extends Error {
  constructor(public readonly method: keyof SpriteActivities) {
    super(
      `SpriteActivities.${method}: not wired to a real sprite backend yet — sprite lifecycle wiring is #1942 ` +
        `(epic #1564 phase 2). Inject a real or fake ("sprites-fake"/"sprites-emulator") implementation to ` +
        `exercise "run-agent" end to end.`,
    );
    this.name = "SpriteActivitiesNotWiredError";
  }
}

/** Phase 1's placeholder default: every method throws `SpriteActivitiesNotWiredError`. See that class's doc comment. */
export function defaultSpriteActivities(): SpriteActivities {
  const notWired =
    <M extends keyof SpriteActivities>(method: M) =>
    async (): Promise<never> => {
      throw new SpriteActivitiesNotWiredError(method);
    };
  return {
    create: notWired("create"),
    checkpoint: notWired("checkpoint"),
    exec: notWired("exec"),
    restore: notWired("restore"),
    destroy: notWired("destroy"),
    writeFile: notWired("writeFile"),
    readFile: notWired("readFile"),
  };
}

// ── capability ───────────────────────────────────────────────────────────

/**
 * Build the `run-agent` capability. `sprites` is the injectable
 * `SpriteActivities` seam (default: `defaultSpriteActivities()`, phase 1's
 * not-wired-yet placeholder — see that function's doc comment) so unit tests
 * never touch a real/emulated sprite, mirroring `createDockerBuildCapability`'s
 * `executor: CloudExecutor` parameter (./build.ts).
 *
 * `run()`/`rollback()` are typed stubs for phase 1 (#1941) — they reject with
 * `CapabilityNotImplementedError`, exactly like every other unimplemented
 * verb (../capability.ts's module doc; see also ./stub.ts's `stubCapability`
 * helper, which this mirrors by hand rather than delegates to, so the
 * intended sequence stays documented in this module rather than only in the
 * issue).
 *
 * The intended sequence (#1942 fills this in):
 *  - `run()`: `sprites.create` (fresh, or reuse `workspace.spriteName`) ->
 *    `sprites.checkpoint` (`comment: workspace.checkpointComment ?? "pre-run"`)
 *    -> `sprites.writeFile` to stage the prompt -> `sprites.exec` the runtime
 *    CLI matching the resolved `Agent.runtime` -> `sprites.readFile` to
 *    collect artifacts/diff -> `sprites.destroy` unless the workspace was a
 *    warm-start reuse.
 *  - `rollback()`: `sprites.restore({ id: spriteId, checkpoint: checkpointId })`
 *    — the sole compensation, restoring to the pre-run checkpoint `run()`
 *    captured. No hand-written inverse action; "the environment is the
 *    transaction."
 *
 * `rollbackPolicy: "native"` is set explicitly (not left to
 * ../capability.ts's `rollback`-method inference) so the design commitment
 * reads directly off this capability's declaration: a mutating `run-agent`
 * step never needs a `noRollback` opt-out for COMP003
 * (../lint/rules/comp/comp003-mutating-no-rollback.ts).
 */
export function createRunAgentCapability(
  sprites: SpriteActivities = defaultSpriteActivities(),
): Capability<RunAgentInput, RunAgentOutput> {
  // Captured so a real `run()` (#1942) can thread `sprites` straight through
  // without changing this factory's signature; unused until then.
  void sprites;
  return {
    kind: "run-agent",
    rollbackPolicy: "native",
    async run(): Promise<RunAgentOutput> {
      throw new CapabilityNotImplementedError("run-agent");
    },
    async rollback(): Promise<void> {
      throw new CapabilityNotImplementedError("run-agent");
    },
  };
}

/** Default `run-agent` capability, backed by the not-wired-yet placeholder `SpriteActivities`. */
export const runAgentCapability: Capability<RunAgentInput, RunAgentOutput> = createRunAgentCapability();
