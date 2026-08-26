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
 * **Scope across phases.** Phase 1 (#1941) shipped the typed contract only —
 * `run`/`rollback` were stubs throwing `CapabilityNotImplementedError`, per
 * ../capability.ts's own module doc ("Verb implementations live under
 * `./verbs/*` as typed stubs — no cloud calls, no side effects. Cloud
 * implementations are a later phase"). `rollbackPolicy: "native"` was declared
 * from phase 1 (so COMP003, ../lint/rules/comp/comp003-mutating-no-rollback.ts,
 * never requires a `noRollback` opt-out for this verb once it composes into a
 * component) even before the paired `rollback` body was real — the *policy*
 * was the phase 1 design commitment, the *implementation* is phase 2 (#1942,
 * below). This capability is deliberately not yet registered in any
 * `CapabilityPlugin`'s `STARTER_VERB_FAMILIES`-equivalent set — the fly
 * lexicon's own plugin (`lexicons/fly/src/components/capability-plugin.ts`)
 * registers it under its own `FLY_VERB_FAMILIES`, but that is a separate,
 * later decision from "does core's sequencing logic actually work," which
 * this module answers. #1943 ("Provenance + attestation") owns the
 * `provenance.sourceRef` transcript-hash basis and verify-gate interop; #1944
 * owns the conformance/contract test suite (saga-unwind restore, COMP003
 * refusal) beyond this module's own unit tests.
 *
 * **#1942 (phase 2, this module's `run`/`rollback` body) resolved the
 * following:**
 *  - **The exec-throw finding** (pre-merge review of #1946, recorded on
 *    #1942): the real `spriteExec` (`lexicons/fly/src/op/activities/sprites.ts`)
 *    throws on any non-zero exit, so a *thin* `SpriteActivities.exec` adapter
 *    can only ever produce `turn.status: "failed"` without throwing if it
 *    reclassifies that throw itself. That reclassification is the fly
 *    lexicon adapter's job (`lexicons/fly/src/components/run-agent.ts`,
 *    option (a) from the review comment) — `SpriteActivities.exec`'s
 *    contract, as this module consumes it, is: **resolve** with `exitCode`
 *    for any ordinary command outcome (zero or non-zero), **reject** only for
 *    a genuine transport/infra failure. `run()` below trusts that contract
 *    completely: it never wraps `sprites.exec` in a try/catch, so a rejection
 *    from the injected `sprites` always propagates as a genuine `run()`
 *    failure (triggering saga rollback in ../driver.ts), while an ordinary
 *    non-zero exit becomes `turn.status: "failed"` on a normal return —
 *    exactly the non-throwing first-class result the type already declared.
 *  - **Rollback identity.** `rollback(ctx, input)` receives the identical
 *    `input` object `run(ctx, input)` was called with (never `run`'s output —
 *    ../driver.ts's saga unwind stores `resolvedInput`, not a step's return
 *    value, precisely so `rollback` can be called with "the same input" per
 *    capability, the same contract `../../lexicons/aws/.../host-delivery.ts`'s
 *    `code-deploy` rollback already relies on). `run()` records the sprite id
 *    it created/reused in a private `WeakMap` keyed by that exact `input`
 *    object, so `rollback()` recovers it with no persisted state and no
 *    network round-trip — this works for ../driver.ts's saga unwind (which
 *    runs entirely in-process, right after the failing `run()`, per that
 *    module's own doc) and for this module's own tests calling `rollback()`
 *    directly after `run()`. When no such record exists (a different
 *    capability instance / process resumed against an already-created
 *    sprite), `rollback()` falls back to the caller-supplied
 *    `workspace.spriteName` and throws a descriptive error only if neither is
 *    available — there is no sprite id to restore. The checkpoint itself is
 *    *not* threaded through this map: restore always resolves by
 *    `workspace.checkpointComment` (default `"pre-run"`), the same
 *    comment-based resolution `spriteRestore`/`pickCheckpointByComment`
 *    (`lexicons/fly/src/op/activities/sprites.ts`) already implement — one
 *    fewer piece of state to keep in sync.
 *  - **Destroy vs. leave-alive.** `run()` destroys a freshly created (not
 *    `workspace.spriteName`-reused) sprite only when `turn.status ===
 *    "completed"`. An ordinary failed turn leaves the sprite alive — it
 *    returned normally, so no saga rollback runs, but the failure is exactly
 *    when a caller (or this module's own tests) most wants to inspect the
 *    sprite or explicitly call `rollback()` to restore it, per this issue's
 *    acceptance criteria.
 *
 * **Still open, left for later phases:**
 *  - Runtime invocation inside the sprite — `buildRuntimeCommand` below picks
 *    a real one-shot CLI invocation for each known `Agent.runtime` value,
 *    reading the staged prompt file; whether the sprite image already carries
 *    that CLI (vs. `run()` needing a setup step) is unresolved. `RunAgentInput`
 *    (frozen by #1941) has no separate `runtime` field, so `input.agent`
 *    doubles as the runtime selector for phase 2 — an unrecognized value is
 *    passed through verbatim as a literal command (a documented escape hatch
 *    for a custom binary already present in the image, and how this module's
 *    own tests exercise a scripted failure against the offline fake). Real
 *    `agent` name/id -> `Agent.runtime` resolution against fountain's
 *    `/api/agents` (`resolveAgentId`, `lexicons/fountain/.../fountain-run.ts`)
 *    is out of this issue's scope (and would need a network call the offline
 *    path forbids).
 *  - Output artifact encoding — `run()` reads one conventional path
 *    (`/work/output`) as the sole `artifacts.files` entry when present;
 *    individual `spriteReadFile` calls per changed path vs. one tarred
 *    snapshot folded into a `BuildArchiveManifest` entry (./build-archive.ts)
 *    remains an open question, as does `artifacts.diff`, which `run()` never
 *    populates (the real Sprites API has no built-in diff endpoint).
 *  - Interrupted turns — `turn.status: "interrupted"` stays in the type but
 *    is unreachable from this implementation: any `sprites.exec` rejection
 *    (including one caused by an aborted signal) propagates as a genuine
 *    `run()` failure rather than being classified as an interrupted turn.
 *    Distinguishing "deadline hit mid-run" from "the sprite backend errored"
 *    well enough to surface `"interrupted"` safely is left for #1943.
 *  - Transcript hash basis — `provenance.sourceRef` below is `input.sourceRef
 *    ?? ""`, a documented placeholder (#1943 owns the real transcript-hash
 *    basis and verify-gate interop); `provenance.artifactDigest` is the
 *    digest of the collected `/work/output` artifact when there is one, else
 *    the digest of an empty string.
 */

import { createHash } from "node:crypto";
import type { Capability, DeployContext } from "../capability";
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
 * Thrown by `defaultSpriteActivities()`'s methods when a caller never injects
 * a real (or fake) `SpriteActivities` — the default remains this
 * not-wired-yet placeholder even after #1942 wires `run()`/`rollback()`'s
 * sequencing logic, because *some* concrete backend still has to be supplied
 * for that logic to have anything to call. `lexicons/fly/src/components/
 * run-agent.ts`'s adapter (the real backend, over this lexicon's own sprite
 * lifecycle activities) or the offline `sprites-fake`/`sprites-emulator` path
 * are what a caller injects instead. A caller that supplies its own
 * `SpriteActivities` never hits this class.
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
 * `SpriteActivities` seam (default: `defaultSpriteActivities()`, the
 * not-wired-yet placeholder — see that function's doc comment) so unit tests
 * never touch a real/emulated sprite, mirroring `createDockerBuildCapability`'s
 * `executor: CloudExecutor` parameter (./build.ts). The fly lexicon's
 * `flyRunAgentCapability` (`lexicons/fly/src/components/run-agent.ts`) is
 * this same factory called with its real `SpriteActivities` adapter.
 *
 * `run()`: `sprites.create` (skipped when reusing `workspace.spriteName`) ->
 * `sprites.checkpoint` (`comment: workspace.checkpointComment ?? "pre-run"`)
 * -> `sprites.writeFile` to stage the prompt -> `sprites.exec` the runtime
 * command (`buildRuntimeCommand`) -> `sprites.readFile` to collect the sole
 * artifact -> `sprites.destroy`, only for a freshly created sprite whose turn
 * completed. See this module's doc comment for the exec-throw resolution,
 * the destroy-vs-leave-alive rule, and the rollback-identity design.
 *
 * `rollback()`: `sprites.restore({ id: spriteId, comment })` — the sole
 * compensation, restoring to the pre-run checkpoint by comment (see this
 * module's doc comment, "Rollback identity"). No hand-written inverse
 * action; "the environment is the transaction."
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
  // Keyed by the exact `input` object `run()` was called with — see this
  // module's doc comment ("Rollback identity") for why this is sufficient
  // (and preferable to threading state through `RunAgentOutput`, which
  // `rollback()` never receives).
  const stateByInput = new WeakMap<RunAgentInput, RunAgentRunState>();

  return {
    kind: "run-agent",
    rollbackPolicy: "native",
    async run(ctx, input): Promise<RunAgentOutput> {
      const reused = Boolean(input.workspace.spriteName);
      const spriteId = input.workspace.spriteName ?? generateSpriteName(ctx);
      if (!reused) {
        await sprites.create({ name: spriteId, image: input.workspace.image });
      }

      const checkpointComment = input.workspace.checkpointComment ?? "pre-run";
      const { checkpointId } = await sprites.checkpoint({ id: spriteId, comment: checkpointComment });
      // Recorded as early as possible: even if a later step throws (a genuine
      // infra failure, triggering saga rollback), `rollback()` still finds
      // the sprite id it needs to restore.
      stateByInput.set(input, { spriteId });

      await sprites.writeFile({ id: spriteId, path: PROMPT_PATH, content: input.task.prompt, mkdir: true });

      const startedAt = new Date().toISOString();
      // No try/catch here by design (see this module's doc comment, "The
      // exec-throw finding"): `sprites.exec` resolves with `exitCode` for any
      // ordinary command outcome and rejects only for a genuine infra
      // failure, which should propagate and trigger saga rollback.
      const execResult = await sprites.exec({ id: spriteId, cmd: buildRuntimeCommand(input.agent) });
      const turn: RunAgentTurn = {
        status: execResult.exitCode === 0 ? "completed" : "failed",
        exitCode: execResult.exitCode,
        startedAt,
        endedAt: new Date().toISOString(),
      };

      const artifacts = await collectArtifacts(sprites, spriteId);

      // Destroy only on a normal-return success. A failed turn (status
      // "failed") leaves the sprite alive — no saga rollback runs for it
      // (run() returned, it didn't throw), so this is the caller's own
      // window to inspect the sprite or explicitly call rollback().
      if (!reused && turn.status === "completed") {
        await sprites.destroy({ id: spriteId });
      }

      const provenance: ProvenanceLink = {
        sourceRef: input.sourceRef ?? "",
        artifactDigest: artifacts.files[0]?.digest ?? EMPTY_DIGEST,
      };

      return { spriteId, checkpointId, turn, artifacts, provenance };
    },
    async rollback(_ctx, input): Promise<void> {
      const state = stateByInput.get(input);
      const spriteId = state?.spriteId ?? input.workspace.spriteName;
      if (!spriteId) {
        throw new Error(
          'run-agent rollback: no sprite id to restore. This capability instance never ran "run()" for this ' +
            'exact input (its in-memory record is gone — e.g. a different process or capability instance), and ' +
            '"workspace.spriteName" was not supplied, so there is no way to identify which sprite to restore. ' +
            "Supply \"workspace.spriteName\" for any sprite whose rollback might need to run outside the run() " +
            "call that created it.",
        );
      }
      const comment = input.workspace.checkpointComment ?? "pre-run";
      await sprites.restore({ id: spriteId, comment });
    },
  };
}

// ── run() helpers ────────────────────────────────────────────────────────

/** The conventional path `run()` writes the staged prompt to and reads the sole artifact from — the same `/work/*` convention `examples/sprites-agent-task/ops/agent-task.op.ts`'s Stage/Collect phases use. */
const PROMPT_PATH = "/work/prompt";
const OUTPUT_PATH = "/work/output";

/** `sha256:<hex>` over a string, prefixed the same way ./build-archive.ts's `contentDigest` and ./build.ts's zip/jar digests are. */
function sha256Digest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

const EMPTY_DIGEST = sha256Digest("");

/**
 * Map `RunAgentInput.agent` to the one-shot, non-interactive command that
 * reads the staged prompt (`PROMPT_PATH`) and runs it inside the sprite. Each
 * known `RunAgentRuntime` gets its real CLI invocation; any other value is
 * passed through verbatim as a literal command — a real-world escape hatch
 * for a custom binary already present in the sprite image, and how this
 * module's own tests drive a scripted failure/success against the offline
 * fake without needing a real CLI. See this module's doc comment ("Still
 * open, left for later phases") for why no fountain resolution happens here.
 */
export function buildRuntimeCommand(agent: string): string {
  switch (agent as RunAgentRuntime) {
    case "claude":
      return `claude -p "$(cat ${PROMPT_PATH})" --output-format json`;
    case "codex":
      return `codex exec "$(cat ${PROMPT_PATH})"`;
    case "gemini":
      return `gemini -p "$(cat ${PROMPT_PATH})"`;
    case "opencode":
      return `opencode run "$(cat ${PROMPT_PATH})"`;
    default:
      return agent;
  }
}

/** Deterministic-enough default sprite name when `workspace.spriteName` is omitted — not required to be reproducible across calls (see this module's doc comment on rollback identity: the `WeakMap` is what makes rollback work, not the name shape). */
function generateSpriteName(ctx: DeployContext): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `run-agent-${ctx.component}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Read `OUTPUT_PATH` as the turn's sole artifact, when present. A missing/unreadable file (e.g. a failed turn that never wrote it) is not an error — `artifacts.files` is simply empty. */
async function collectArtifacts(
  sprites: SpriteActivities,
  spriteId: string,
): Promise<RunAgentOutput["artifacts"]> {
  try {
    const { content } = await sprites.readFile({ id: spriteId, path: OUTPUT_PATH });
    return { files: [{ path: OUTPUT_PATH, digest: sha256Digest(content) }] };
  } catch {
    return { files: [] };
  }
}

/** Per-`input` record of what `run()` did, so `rollback()` (called with the same `input` object — see this module's doc comment) can recover the sprite id without any persisted state. */
interface RunAgentRunState {
  spriteId: string;
}

/** Default `run-agent` capability, backed by the not-wired-yet placeholder `SpriteActivities`. */
export const runAgentCapability: Capability<RunAgentInput, RunAgentOutput> = createRunAgentCapability();
