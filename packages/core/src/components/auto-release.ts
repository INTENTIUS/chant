/**
 * Auto-emit a release-ledger record from a successful `chant run --components
 * <name> --env <env>` (#597, follow-up to #568/epic #551). Before this, the
 * release ledger (../lifecycle/release-ledger.ts) was only populated by the
 * standalone `chant components release <env>` command — a deploy that never
 * called it left the ledger silently empty. This module makes recording
 * happen *by construction*: the CLI post-run step for both the local
 * executor (`runOpComponents`) and the durable Temporal path
 * (`runComponentTemporal`) calls `maybeRecordAutoRelease` after the run
 * reports success.
 *
 * Deliberately CLI-side, not driver-side or workflow-side:
 *  - `../components/driver.ts` stays capability-agnostic — it already
 *    resists per-component/per-capability branching, and "write to git"
 *    is exactly the kind of side effect that doesn't belong in a step
 *    dispatcher tests exercise against a bare `CapabilityRegistry`.
 *  - The Temporal workflow (lexicons/temporal/src/component-op/) must stay
 *    deterministic and replay-safe. A ledger write is a non-idempotent git
 *    push with real-world side effects (network, `Date.now()`, file writes
 *    outside workflow state) — precisely what Temporal workflow code must
 *    never do directly. It happens in the CLI, after `handle.describe()`
 *    reports a terminal COMPLETED status, the same place `runOpTemporal`
 *    already writes its deployment report post-run.
 *
 * Reuses ../lifecycle/release-ledger.ts's `appendReleaseRecord` verbatim —
 * this module only decides *whether* to call it and *what digest* to record,
 * mirroring the field-resolution `runComponentsReleaseRecord`
 * (../cli/handlers/components.ts) already does for the standalone command
 * (`--git-sha` defaults to HEAD, `--run-id`/`--actor` fall back to common CI
 * env vars, timestamp is a real `new Date()` taken at record time).
 */
import { getHeadCommit, pushLifecycle, StaleLifecycleBranchError } from "../lifecycle/git";
import { appendReleaseRecord, InvalidReleaseRecordError, type ReleaseRecord } from "../lifecycle/release-ledger";
import type { DriverStepRecord } from "./driver";

/**
 * A step output that represents a *promoted* artifact — a publish-family result
 * (publish-image / publish-artifact / load-image-on-host), identified by the
 * location `uri` all three carry (`repo@sha256:…`, `host:…#…`, an artifact URL).
 * This deliberately excludes outputs that carry only a content `digest`: e.g.
 * `generate-sbom`'s `digest` is the SBOM document's own bytes, and
 * `extract-config-bom` likewise *describes* an artifact rather than promoting
 * one. Those must not trigger a release record (#665) — a release means "we
 * promoted this by digest to a location", not "we hashed some bytes". The
 * driver's own `findPublishOutput` stays looser (uri/digest/key) because it
 * only feeds `@<component>.publish.*` wiring, where a false positive is harmless.
 */
function isPromotedArtifact(output: unknown): output is { uri: string; digest?: string } {
  return !!output && typeof output === "object" && "uri" in output && typeof (output as { uri?: unknown }).uri === "string";
}

/**
 * Extract the artifact digest a component run promoted, by scanning its step
 * records for the last {@link isPromotedArtifact promoted-artifact} output (a
 * publish-family result carrying a location `uri`) and taking its `digest`, so
 * a release record is only ever attempted when the run actually promoted
 * something by digest. Returns undefined when no step promoted an artifact —
 * e.g. a component whose deploy has no publish step, even if it ran
 * `generate-sbom` (whose content `digest` is not a promotion, #665) — the
 * caller treats that as "nothing to record", not an error. Used by the
 * local-executor CLI path, which has the full `DriverStepRecord[]` from
 * `runComponentDeploy`.
 */
export function extractRunDigest(records: DriverStepRecord[]): string | undefined {
  let found: string | undefined;
  for (const record of records) {
    if (record.status !== "ok") continue;
    if (isPromotedArtifact(record.output) && typeof record.output.digest === "string") {
      found = record.output.digest;
    }
  }
  return found;
}

/**
 * Same digest extraction as `extractRunDigest`, but over a component
 * Temporal workflow's returned `phaseOutputs` (`{ [phase]: output }`) instead
 * of a `DriverStepRecord[]` — the shape `handle.result()` resolves to for a
 * COMPLETED component workflow (see lexicons/temporal/src/component-op/
 * serializer.ts's generated `return { phaseOutputs, componentOutputs }`).
 * Used by the `--temporal` CLI path, which never sees individual step
 * records (those exist only inside the workflow/activities).
 */
export function extractRunDigestFromPhaseOutputs(
  phaseOutputs: Record<string, Record<string, unknown>> | undefined,
): string | undefined {
  let found: string | undefined;
  for (const output of Object.values(phaseOutputs ?? {})) {
    if (isPromotedArtifact(output) && typeof output.digest === "string") {
      found = output.digest;
    }
  }
  return found;
}

/** Explicit reasons `maybeRecordAutoRelease` declined to write a record — never a thrown error, since "nothing to record" (or "opted out") is an expected, common outcome. */
export type AutoReleaseSkipReason =
  | "opted-out"
  | "run-not-successful"
  | "no-digest"
  | "no-actor";

export type AutoReleaseResult =
  | { recorded: true; commit: string; record: ReleaseRecord }
  | { recorded: false; reason: AutoReleaseSkipReason; detail?: string }
  | { recorded: false; reason: "error"; error: string };

/** Input describing one component's completed run, common to both the local-executor and Temporal-durable CLI paths. */
export interface AutoReleaseRunInfo {
  component: string;
  env: string;
  /** Whether the run reported overall success — `DriverRunResult.ok` (local) or a terminal `COMPLETED` Temporal status. A caller must not call this for a non-terminal/in-progress run. */
  success: boolean;
  /** The component's step records (local executor), used to locate the published digest via `extractRunDigest`. Mutually exclusive with `digest` — pass whichever the caller already has. */
  records?: DriverStepRecord[];
  /** A digest already resolved by the caller (e.g. the `--temporal` path, via `extractRunDigestFromPhaseOutputs` over the workflow's `handle.result()`). Takes precedence over `records` when both are given. */
  digest?: string;
  /** Orchestrator run identifier — a Temporal `runId`, or a locally generated id for the local executor (mirrors `runComponentsReleaseRecord`'s `--run-id` default). */
  runId: string;
}

/** Opt-out + field-override knobs for auto-release recording, threaded from CLI flags/config (#597: "opt-out-able (flag/config), documented default"). */
export interface AutoReleaseOptions {
  /** `--no-release-record` / `chant.config.ts`'s `release.autoRecord: false` — skip emission entirely. Default: emission is ON. */
  disabled?: boolean;
  /** Override the git sha to record (tests, or a caller that already resolved it). Defaults to `git rev-parse HEAD`. */
  gitSha?: string;
  /** Override the actor to record. Defaults to `$GITHUB_ACTOR`/`$GITLAB_USER_LOGIN`/`$USER`, matching `runComponentsReleaseRecord`. */
  actor?: string;
  /** Working directory for the git plumbing calls (tests). */
  cwd?: string;
}

function resolveActor(override?: string): string | undefined {
  return override ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
}

/**
 * After a successful `chant run --components <name> --env <env>` (local or
 * `--temporal`), append exactly one immutable release record to the ledger
 * and push it — or explain, without throwing, why it didn't. Never called
 * for a failed run (`run.success` must be true before the caller invokes
 * this at all; see `runOpComponents`/`runComponentTemporal`) — a failed
 * deploy writes nothing, by construction, since this function is simply
 * never reached on that path.
 *
 * Skips (returns `{ recorded: false, reason }`, never throws for these
 * expected cases):
 *  - `options.disabled` — the opt-out flag/config was set.
 *  - `run.success` false — defensive; callers should not reach here on failure.
 *  - no digest found in the run's records — a component with no publish step
 *    has nothing to bind a release record to.
 *  - no resolvable actor — mirrors `runComponentsReleaseRecord`'s hard
 *    requirement; an unattributed record defeats the ledger's purpose.
 *
 * Git-sha resolution failure and ledger-write failures
 * (`InvalidReleaseRecordError`, `StaleLifecycleBranchError`, or any other
 * error `appendReleaseRecord`/`pushLifecycle` throw) are reported as `{
 * recorded: false, reason: "error", error }` rather than propagated — an
 * auto-recorded ledger write is a best-effort observability side effect of a
 * successful deploy; it must never turn a successful `chant run --components`
 * into a failing CLI invocation. The caller should still surface the message
 * as a warning.
 */
export async function maybeRecordAutoRelease(
  run: AutoReleaseRunInfo,
  options: AutoReleaseOptions = {},
): Promise<AutoReleaseResult> {
  if (options.disabled) {
    return { recorded: false, reason: "opted-out" };
  }
  if (!run.success) {
    return { recorded: false, reason: "run-not-successful" };
  }

  const digest = run.digest ?? extractRunDigest(run.records ?? []);
  if (!digest) {
    return { recorded: false, reason: "no-digest", detail: `component "${run.component}" published no digest-bearing artifact` };
  }

  const actor = resolveActor(options.actor);
  if (!actor) {
    return { recorded: false, reason: "no-actor", detail: "could not resolve an actor from GITHUB_ACTOR/GITLAB_USER_LOGIN/USER" };
  }

  let gitSha: string | undefined = options.gitSha;
  try {
    gitSha ??= await getHeadCommit({ cwd: options.cwd });
  } catch (err) {
    return { recorded: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }

  const timestamp = new Date().toISOString();

  try {
    const { commit, record } = await appendReleaseRecord(
      {
        component: run.component,
        env: run.env,
        digest,
        gitSha,
        runId: run.runId,
        timestamp,
        actor,
      },
      { cwd: options.cwd },
    );
    await pushLifecycle({ cwd: options.cwd });
    return { recorded: true, commit, record };
  } catch (err) {
    if (err instanceof InvalidReleaseRecordError || err instanceof StaleLifecycleBranchError) {
      return { recorded: false, reason: "error", error: err.message };
    }
    return { recorded: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
