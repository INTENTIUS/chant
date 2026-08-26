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
 *  - **Rollback identity (#1944 closes the durable-path gap left open here).**
 *    `rollback(ctx, input, output)` receives the identical `input` object
 *    `run(ctx, input)` was called with, plus (since #1944) the exact `output`
 *    `run()` returned — `../capability.ts`'s `Capability.rollback` grew an
 *    optional third parameter for precisely this, and ../driver.ts's saga
 *    unwind (both the local in-process path and, via
 *    `lexicons/temporal/src/component-op/{activities,serializer}.ts`, the
 *    durable Temporal path) always threads it through. `run()` records the
 *    sprite id and exact pre-run checkpoint id two ways: in a private
 *    `WeakMap` keyed by the exact `input` object (works only when `rollback`
 *    is called with that same object — true in-process, e.g. this module's
 *    own tests calling `rollback()` directly after `run()`), and — the
 *    durable-safe channel — as `output.spriteId`/`output.checkpointId`,
 *    already part of `RunAgentOutput` (#1943). `rollback()` prefers `output`'s
 *    fields when present, falling back to the `WeakMap` only when a caller
 *    never threads `output` through (backward-compatible for any capability
 *    caller not yet passing it). **The checkpoint id, not the comment, is
 *    what `rollback()` restores by** when either source has one:
 *    `sprites.restore({ id, checkpoint: checkpointId })`, which
 *    `spriteRestore`'s explicit-id resolution wins over comment on
 *    (`lexicons/fly/src/op/activities/sprites.ts`). Restoring by comment alone
 *    is unsafe on a reused sprite — two `run()` calls sharing the default
 *    `"pre-run"` comment would make a comment-based restore always resolve to
 *    the *newest* matching checkpoint, so rolling back the first run would
 *    restore the second run's checkpoint (which already contains the first
 *    run's mutation) instead of undoing it. Comment-based restore
 *    (`workspace.checkpointComment`, default `"pre-run"`) is therefore only a
 *    **fallback**, used when no checkpoint id is available from either source
 *    (the `workspace.spriteName`-only path below). When there is no sprite id
 *    to restore at all (no `output`, no `WeakMap` record, no
 *    `workspace.spriteName`), `rollback()` degrades with an explicit,
 *    commented no-op return — the same pattern
 *    `../../lexicons/aws/src/components/host-delivery.ts`'s `code-deploy`
 *    rollback uses (`if (!deploymentId) return;`) — rather than throwing.
 *    **Before #1944**, the Temporal durable path (`run` and `rollback`
 *    executing as separate Activities, each rebuilding `input` fresh via
 *    `resolveStepInput`) never gave the `WeakMap` a hit, so a fresh sprite's
 *    rollback there silently degraded to that no-op; passing `output` through
 *    (this revision) closes that gap directly, without redesigning the
 *    component-op wire format — see #1944's PR description for why this was
 *    chosen over the "make the degrade loud" alternative. The generated
 *    workflow's saga-unwind loop (`lexicons/temporal/src/component-op/
 *    serializer.ts`) also no longer swallows a rollback failure silently
 *    (any capability's, not just this one) — it now logs it and surfaces it
 *    via a `RollbackFailed` search attribute, defense in depth for a rollback
 *    failure unrelated to identity (e.g. the sprite backend itself erroring).
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
 *    well enough to surface `"interrupted"` safely is left for #1944.
 *
 * **#1943 (this revision) resolved the transcript-hash basis and
 * sign/verify-gate interop, closing #1941's open "transcript hash basis"
 * question:**
 *  - **Hash basis.** `provenance.sourceRef`'s digest component is
 *    `sha256Digest(JSON.stringify(basis))` over a fixed-key-order object —
 *    `{ agent, promptDigest, images, status, exitCode, stdoutDigest,
 *    stderrDigest, artifacts, diffDigest }` — built fresh by
 *    `computeTranscriptDigest` below every call, never re-ordered from a
 *    caller-supplied object, so key order (and therefore the digest) never
 *    drifts by construction. Every free-text field (`prompt`, `stdout`,
 *    `stderr`, `diff`, each image's `data`) is folded in as its own
 *    `sha256Digest`, not embedded verbatim — this keeps a (possibly large,
 *    possibly secret-bearing) prompt or transcript out of the digest input's
 *    own byte stream while the digest remains exactly as sensitive to those
 *    bytes as embedding them would be, and it is *why* this module never
 *    needs to retain raw stdout/stderr past computing their digest inline
 *    (closing #1941's "is the raw transcript retained anywhere beyond the
 *    attested digest" sub-question: no, not even internally). `startedAt`/
 *    `endedAt` are deliberately excluded — including wall-clock time would
 *    make "the same turn" (same prompt, same exec outcome, same artifacts)
 *    hash differently on every real run, defeating the determinism property
 *    (`same turn -> same sourceRef`) a verifier actually needs: identity is
 *    about *what happened*, not *when*. `artifacts.files` is sorted by
 *    `path` before hashing so collection order (never semantically
 *    meaningful — there is exactly one conventional artifact today, see
 *    `OUTPUT_PATH`) can't perturb the digest.
 *  - **`sourceRef` folding.** `RunAgentInput.sourceRef`'s own doc comment
 *    promises it is "folded into the output's `provenance.sourceRef`
 *    alongside the transcript hash." Concretely: `sourceRef =
 *    input.sourceRef ? \`${input.sourceRef}@${transcriptDigest}\` :
 *    transcriptDigest` — an `"<sha>@sha256:<hex>"` shape when a source ref is
 *    known, reading like the `repo@sha256:...` convention already used
 *    throughout this codebase (./sign.ts, ./publish.ts's `uri`), or the bare
 *    `sha256:<hex>` transcript digest alone when it is not. `@` (not `:`,
 *    which `DockerBuildInput.sourceRef`'s own `"<sha>:<path>"` convention
 *    already uses for a different purpose) keeps the split unambiguous.
 *    `extractTranscriptDigest` below recovers the trailing
 *    `sha256:<hex>` deterministically regardless of what `input.sourceRef`
 *    contains, by anchoring on the fixed `sha256:[0-9a-f]{64}` pattern at the
 *    very end of the string.
 *  - **Attestation interop, decided.** `RunAgentOutput` gained one field,
 *    `attestationRef` — a `"<component>/run-agent@sha256:<hex>"` string
 *    already shaped like the digest-qualified `repo@sha256:...` reference
 *    `./sign.ts`'s `assertDigestRef`/`./verify.ts` already require, built
 *    from `ctx.component` and the transcript digest, so a `sign`/
 *    `attest-provenance`/`verify` step composed after `run-agent` wires
 *    `imageRef: "@RunAgent.attestationRef"` and needs **zero code changes**
 *    to any of those three verbs — resolving design point 4 of #1943 exactly
 *    as anticipated. The honest caveat, stated plainly rather than left
 *    implicit: `attestationRef` is *shaped* like an OCI digest reference, but
 *    is not by itself a real, registry-resolvable one — `run-agent`'s turn
 *    output is never pushed anywhere by this module. A deployment that wants
 *    a genuine `cosign sign`/`cosign verify` round trip against real
 *    Rekor/Fulcio needs a registry-backed publish step ahead of `sign`
 *    (mirroring `publish-image`'s `uri`, ./publish.ts) — out of this issue's
 *    scope, and not needed for the offline contract this issue asks for
 *    (injected `ProcessRunner`, no real `cosign`/registry ever touched).
 *    `toRunAgentArchiveEntry` below folds the same digest into a
 *    `BuildArchiveEntry` (`kind: "asset"`, ./build-archive.ts) per design
 *    point 2, for a caller building a full archive manifest.
 *  - **Predicate-type decision, made (not left open).** Reuses the existing
 *    `predicateType: "https://slsa.dev/provenance/v1"` unchanged — does
 *    *not* mint a `run-agent`-specific predicate type. `buildDefinition
 *    .buildType` is the field SLSA v1 actually designates for "what kind of
 *    recipe produced this" (`RUN_AGENT_BUILD_TYPE` below,
 *    `"https://chant.dev/agent-turn/v1"`, the same role
 *    `./sign.ts`'s `DEFAULT_BUILD_TYPE` plays for `docker-build`), so a
 *    second, parallel `predicateType` taxonomy would duplicate what
 *    `buildType` already discriminates. This is also what makes the "zero
 *    code changes to `verify.ts`" claim above literally true:
 *    `buildVerifyAttestationArgs` hardcodes `--type slsaprovenance1` — a
 *    minted `predicateType` would have broken that interop outright, forcing
 *    a `verify.ts` change this issue's design point 4 explicitly hoped to
 *    avoid.
 *  - **Fountain-supplied facts, honestly scoped.** `buildRunAgentProvenanceStatement`
 *    below folds `input.agent` into `externalParameters` (the one *declared*
 *    fact `RunAgentInput` actually carries today) and `spriteId`/
 *    `checkpointId`/`turn.status`/`turn.exitCode` into `internalParameters`
 *    (what actually happened). `model`/`runtime`/`Environment.networking_type`
 *    /`allowed_hosts` are not included — populating them honestly needs
 *    fountain `Agent`/`Environment` resolution against `/api/agents`, which
 *    this module's own doc comment already marks out of scope ("Real `agent`
 *    name/id -> `Agent.runtime` resolution ... is out of this issue's
 *    scope"). Adding those keys later is additive (merged into
 *    `externalParameters`, never replacing it), not a shape break.
 */

import { createHash } from "node:crypto";
import type { Capability, DeployContext } from "../capability";
import type { ProvenanceLink } from "./reproducibility";
import type { BuildArchiveEntry } from "./build-archive";
import { buildProvenanceStatement, type InTotoProvenanceStatement } from "./sign";

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
  /** #614's shape (./reproducibility.ts) — `sourceRef` is the prompt/transcript hash, folded with `input.sourceRef` when supplied (see this module's doc comment, "sourceRef folding"). */
  provenance: ProvenanceLink;
  /**
   * A `"<component>/run-agent@sha256:<hex>"` reference, digest-qualified the
   * same shape `./sign.ts`'s `assertDigestRef`/`./verify.ts` require (#1943)
   * — wire a `sign`/`attest-provenance`/`verify` step composed after
   * `run-agent` with `imageRef: "@RunAgent.attestationRef"` and none of those
   * three verbs need any code change. See this module's doc comment,
   * "Attestation interop, decided" for the honest caveat (shaped like an OCI
   * digest reference, not itself a registry-resolvable one) and
   * `extractTranscriptDigest`/`toRunAgentArchiveEntry`/
   * `buildRunAgentProvenanceStatement` below for the rest of the interop
   * surface built on top of it.
   */
  attestationRef: string;
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
 * `rollback()`: `sprites.restore({ id: spriteId, checkpoint: checkpointId })`
 * — the sole compensation, restoring to the exact pre-run checkpoint `run()`
 * recorded (see this module's doc comment, "Rollback identity"). Prefers the
 * `output` parameter's `spriteId`/`checkpointId` (the durable-safe channel,
 * #1944) over the in-process `WeakMap`, falls back to
 * `sprites.restore({ id: spriteId, comment })` only when neither source has a
 * checkpoint id, and degrades to an explicit no-op when there is no sprite id
 * to restore at all. No hand-written inverse action otherwise; "the
 * environment is the transaction."
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
  // Keyed by the exact `input` object `run()` was called with — a fallback
  // for a caller that never threads `output` through to `rollback()` (see
  // this module's doc comment, "Rollback identity"). The durable-safe path
  // is `output.spriteId`/`output.checkpointId`, already part of
  // `RunAgentOutput` (#1943) and threaded by every current caller (#1944).
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
      // the sprite id and exact checkpoint it needs to restore.
      stateByInput.set(input, { spriteId, checkpointId });

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

      // #1943: the transcript digest — see this module's doc comment ("Hash
      // basis") for the exact fields/order this is computed over.
      // execResult.stdout/stderr never outlive this call: they are folded
      // into the digest right here and discarded, never stored on `turn` or
      // anywhere else in `RunAgentOutput`.
      const transcriptDigest = computeTranscriptDigest({
        agent: input.agent,
        prompt: input.task.prompt,
        images: input.task.images,
        turn,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        artifacts,
      });
      const sourceRef = input.sourceRef ? `${input.sourceRef}@${transcriptDigest}` : transcriptDigest;
      const provenance: ProvenanceLink = {
        sourceRef,
        artifactDigest: artifacts.files[0]?.digest ?? EMPTY_DIGEST,
      };
      const attestationRef = `${ctx.component}/run-agent@${transcriptDigest}`;

      return { spriteId, checkpointId, turn, artifacts, provenance, attestationRef };
    },
    async rollback(_ctx, input, output): Promise<void> {
      // The durable-safe channel first (#1944): `output` is the exact value
      // this step's own `run()` returned, threaded through by every current
      // caller (../driver.ts locally, lexicons/temporal/src/component-op/
      // {activities,serializer}.ts across the Activity boundary) — it
      // survives even when `rollback()` is called with a freshly-rebuilt
      // `input` object the in-process WeakMap below has never seen. Falls
      // back to the WeakMap for a caller that predates/never threads
      // `output` (see this module's doc comment, "Rollback identity").
      const state = stateByInput.get(input);
      const spriteId = output?.spriteId ?? state?.spriteId ?? input.workspace.spriteName;
      if (!spriteId) {
        // No identity from any source (output, in-process record, or
        // "workspace.spriteName"): there is nothing to identify which sprite
        // to restore. Degrade explicitly rather than throwing into a
        // swallowed catch, the same pattern
        // ../../lexicons/aws/src/components/host-delivery.ts's code-deploy
        // rollback uses (`if (!deploymentId) return;`).
        return;
      }
      // Restore the exact pre-run checkpoint when either source recorded
      // one — wins over comment (see "Rollback identity"), and is the only
      // safe choice on a reused sprite where two runs can share the same
      // default "pre-run" comment.
      const checkpointId = output?.checkpointId ?? state?.checkpointId;
      if (checkpointId) {
        await sprites.restore({ id: spriteId, checkpoint: checkpointId });
        return;
      }
      // Fallback: no checkpoint id from either source (e.g.
      // workspace.spriteName-only, no output, no in-process run() record) —
      // resolve by comment, same as before.
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

// ── #1943: transcript hash + attestation interop ────────────────────────────

/**
 * The exact, fixed-key-order shape `computeTranscriptDigest` hashes — see
 * this module's doc comment ("Hash basis") for the full rationale. Every
 * free-text field is its own digest, never embedded verbatim.
 */
interface TranscriptBasis {
  agent: string;
  promptDigest: string;
  images: Array<{ mediaType: string; digest: string }>;
  status: RunAgentTurn["status"];
  exitCode: number | null;
  stdoutDigest: string;
  stderrDigest: string;
  artifacts: Array<{ path: string; digest: string }>;
  diffDigest: string;
}

/**
 * Compute the transcript digest that becomes (the digest component of)
 * `provenance.sourceRef` and `attestationRef` — see this module's doc
 * comment, "Hash basis," for the precise field list/order and the rationale
 * for hashing rather than embedding each free-text field. Exported so a
 * caller (or a test) can independently recompute/verify the same digest from
 * the same run() inputs/outputs, without reaching into this module's private
 * `run()` closure.
 */
export function computeTranscriptDigest(params: {
  agent: string;
  prompt: string;
  images?: RunAgentImageInput[];
  turn: RunAgentTurn;
  stdout: string;
  stderr: string;
  artifacts: RunAgentOutput["artifacts"];
}): string {
  const basis: TranscriptBasis = {
    agent: params.agent,
    promptDigest: sha256Digest(params.prompt),
    images: (params.images ?? []).map((img) => ({ mediaType: img.media_type, digest: sha256Digest(img.data) })),
    status: params.turn.status,
    exitCode: params.turn.exitCode,
    stdoutDigest: sha256Digest(params.stdout),
    stderrDigest: sha256Digest(params.stderr),
    artifacts: [...params.artifacts.files]
      // Code-point ordering, not localeCompare: the digest must be identical
      // across machines regardless of ICU/locale configuration.
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, digest: f.digest })),
    diffDigest: sha256Digest(params.artifacts.diff ?? ""),
  };
  return sha256Digest(JSON.stringify(basis));
}

/** The trailing `sha256:<hex>` transcript digest a `provenance.sourceRef`/`attestationRef` ends in — see this module's doc comment, "sourceRef folding." */
const TRANSCRIPT_DIGEST_PATTERN = /sha256:[0-9a-f]{64}$/i;

/**
 * Recover the bare transcript digest (`sha256:<hex>`) from a
 * `provenance.sourceRef` or `attestationRef` string, regardless of what (if
 * anything) precedes it — see this module's doc comment, "sourceRef
 * folding," for why anchoring on the fixed `sha256:[0-9a-f]{64}` suffix
 * pattern is unambiguous even when `input.sourceRef` itself contains `@`/`:`.
 */
export function extractTranscriptDigest(sourceRef: string): string {
  const match = TRANSCRIPT_DIGEST_PATTERN.exec(sourceRef);
  if (!match) {
    throw new Error(
      `extractTranscriptDigest: "${sourceRef}" does not end in a "sha256:<hex>" transcript digest`,
    );
  }
  return match[0];
}

/**
 * `run-agent`'s SLSA `buildDefinition.buildType` — the recipe-kind URI this
 * module's doc comment ("Predicate-type decision, made") settles on in place
 * of minting a new `predicateType`. Mirrors ./sign.ts's own
 * `DEFAULT_BUILD_TYPE` for `docker-build`.
 */
export const RUN_AGENT_BUILD_TYPE = "https://chant.dev/agent-turn/v1";

/**
 * Fold a `RunAgentOutput` into a `BuildArchiveEntry` (#1943 design point 2,
 * ./build-archive.ts) — `kind: "asset"`, content-addressed by the same
 * transcript digest `attestationRef` carries. Returns a bare entry (no
 * `reproducibility` assigned); pass it through `addArchiveEntry` for the
 * kind-appropriate `"best-effort"` default (./reproducibility.ts), the same
 * as any other `asset` entry.
 */
export function toRunAgentArchiveEntry(component: string, output: RunAgentOutput): BuildArchiveEntry {
  return {
    kind: "asset",
    path: `run-agent/${component}/${output.spriteId}-turn.json`,
    digest: extractTranscriptDigest(output.provenance.sourceRef),
    mediaType: "application/json",
    provenance: output.provenance,
  };
}

/**
 * Build the in-toto SLSA provenance statement for a completed turn, reusing
 * ./sign.ts's `buildProvenanceStatement` unmodified in behavior for every
 * existing (image) caller — `predicateType` stays
 * `"https://slsa.dev/provenance/v1"`, only `buildType` and the
 * `external`/`internalParameters` merge fields (#1943's minimal, documented
 * extension to `BuildProvenanceStatementInput`) differ. See this module's
 * doc comment, "Fountain-supplied facts, honestly scoped," for exactly what
 * is (and is not yet) folded in. The returned statement's `subject` is
 * `output.attestationRef` — sign+attach it the same way `attest-provenance`
 * already does for any other digest-qualified reference.
 */
export function buildRunAgentProvenanceStatement(
  input: RunAgentInput,
  output: RunAgentOutput,
  builderId: string,
  opts?: { finishedOn?: string; invocationId?: string },
): InTotoProvenanceStatement {
  return buildProvenanceStatement({
    imageRef: output.attestationRef,
    provenance: output.provenance,
    builderId,
    buildType: RUN_AGENT_BUILD_TYPE,
    externalParameters: { agent: input.agent },
    internalParameters: {
      spriteId: output.spriteId,
      checkpointId: output.checkpointId,
      turnStatus: output.turn.status,
      turnExitCode: output.turn.exitCode,
    },
    finishedOn: opts?.finishedOn ?? output.turn.endedAt ?? undefined,
    invocationId: opts?.invocationId,
  });
}

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

/**
 * Match the "not found" error shape `lexicons/fly/src/op/activities/
 * sprite-fs.ts`'s `spriteReadFile` throws for a 404 specifically (`sprite
 * <id> read <path>: not found`) — distinct from that same module's >=300
 * `"... failed (<status>): ..."` shape, which is a genuine infra failure. The
 * match is narrow on purpose, mirroring how `lexicons/fly/src/components/
 * run-agent.ts`'s `parseSpriteExecFailure` only reclassifies the one thrown
 * shape it recognizes and lets everything else through.
 */
function isArtifactNotFoundError(err: unknown): boolean {
  return err instanceof Error && /^sprite .+ read .+: not found$/.test(err.message);
}

/**
 * Read `OUTPUT_PATH` as the turn's sole artifact, when present. Only a
 * "not found" read (no artifact was ever written — e.g. a failed turn that
 * never got that far) is treated as "no artifact"; any other error (a
 * genuine transport/infra failure, or a real "failed (<status>)" from the
 * sprite filesystem API) is rethrown so it propagates as a `run()` rejection
 * and triggers saga rollback, instead of being silently swallowed into an
 * empty `artifacts.files`.
 */
async function collectArtifacts(
  sprites: SpriteActivities,
  spriteId: string,
): Promise<RunAgentOutput["artifacts"]> {
  try {
    const { content } = await sprites.readFile({ id: spriteId, path: OUTPUT_PATH });
    return { files: [{ path: OUTPUT_PATH, digest: sha256Digest(content) }] };
  } catch (err) {
    if (isArtifactNotFoundError(err)) return { files: [] };
    throw err;
  }
}

/** Per-`input` record of what `run()` did, so `rollback()` (called with the same `input` object — see this module's doc comment) can recover the sprite id and exact pre-run checkpoint id without any persisted state. */
interface RunAgentRunState {
  spriteId: string;
  checkpointId: string;
}

/** Default `run-agent` capability, backed by the not-wired-yet placeholder `SpriteActivities`. */
export const runAgentCapability: Capability<RunAgentInput, RunAgentOutput> = createRunAgentCapability();
