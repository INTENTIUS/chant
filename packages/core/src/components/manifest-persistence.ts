/**
 * Persist a component run's `BuildArchiveManifest` after a successful `chant
 * run --components <name> --env <env>` (#609, epic #551 follow-up to
 * #564/#568/#606/#613/#614). Mirrors ./auto-release.ts's shape exactly —
 * same "extract from step records, then call a lifecycle-layer writer, then
 * push, and never let a write failure fail an already-successful deploy"
 * structure — because it is solving the same class of problem: the driver
 * produces something worth recording durably, but the driver itself must
 * stay capability-agnostic (../components/driver.ts takes no dependency on
 * ../lifecycle/*), so the CLI performs the write as a post-run step.
 *
 * **Why here, not the driver.** Same reasoning as ./auto-release.ts's module
 * doc: a manifest write is a git commit + push, a non-idempotent side effect
 * with real-world I/O — exactly what `driver.ts` resists taking on (it is
 * exercised in tests against a bare `CapabilityRegistry` with no lifecycle
 * dependency at all) and what Temporal workflow code must never do directly
 * (replay-safety). The CLI calls this after `runComponents`/`handle.result()`
 * reports success, the same place `maybeRecordAutoRelease` is already
 * called from (../cli/handlers/run.ts).
 *
 * **Extraction is duck-typed, not capability-specific.** `docker-build`,
 * `generate-sbom`, `extract-config-bom`, and `addArchiveTemplate` (the
 * build-family capabilities/helpers, ../components/verbs/build.ts,
 * ./verbs/sbom.ts, ./verbs/config-bom.ts) all return `{ ..., manifest:
 * BuildArchiveManifest }` — the accumulation convention documented on each of
 * their inputs ("manifest to extend... same accumulation convention"). This
 * module scans a run's step outputs for that shape, exactly the way
 * ./auto-release.ts's `extractRunDigest` scans for a publish-shaped output,
 * so a new build-family capability that follows the same `{ manifest }`
 * output convention is picked up automatically — no branch here names a
 * specific capability `kind`.
 */
import { persistBuildManifest } from "../lifecycle/build-ledger-store";
import { pushLifecycle } from "../lifecycle/git";
import type { BuildArchiveManifest } from "./verbs/build-archive";
import type { DriverStepRecord } from "./driver";

/** A step output shaped like it carries a `BuildArchiveManifest` — duck-typed the same way ./auto-release.ts's `isPublishShaped` detects a publish result. */
function isManifestShaped(output: unknown): output is { manifest: BuildArchiveManifest } {
  return (
    !!output &&
    typeof output === "object" &&
    "manifest" in output &&
    !!(output as { manifest?: unknown }).manifest &&
    typeof (output as { manifest?: unknown }).manifest === "object"
  );
}

/**
 * Find the most fully-accumulated `BuildArchiveManifest` a component run
 * produced, by scanning its step records for the last manifest-bearing
 * output — mirroring `extractRunDigest`'s "last wins" convention, which is
 * also the correct one here: every build-family capability's `manifest`
 * input/output accumulates onto whatever manifest came before it in the same
 * phase (see ../components/verbs/build.ts's `DockerBuildInput.manifest`
 * doc), so the *last* manifest-bearing step output in run order is always
 * the fullest one — a template + SBOM + config-BOM composition's final step
 * carries every earlier entry too, not just its own.
 */
export function extractRunManifest(records: DriverStepRecord[]): BuildArchiveManifest | undefined {
  let found: BuildArchiveManifest | undefined;
  for (const record of records) {
    if (record.status !== "ok") continue;
    if (isManifestShaped(record.output)) {
      found = record.output.manifest;
    }
  }
  return found;
}

/**
 * Same manifest extraction as `extractRunManifest`, but over a component
 * Temporal workflow's returned `phaseOutputs` (`{ [phase]: output }`) —
 * mirroring ./auto-release.ts's `extractRunDigestFromPhaseOutputs`, the
 * `--temporal` CLI path's counterpart, since that path never sees individual
 * step records either.
 */
export function extractRunManifestFromPhaseOutputs(
  phaseOutputs: Record<string, Record<string, unknown>> | undefined,
): BuildArchiveManifest | undefined {
  let found: BuildArchiveManifest | undefined;
  for (const output of Object.values(phaseOutputs ?? {})) {
    if (isManifestShaped(output)) {
      found = output.manifest;
    }
  }
  return found;
}

/** Explicit reasons `maybePersistBuildManifest` declined to write — never a thrown error, mirroring ./auto-release.ts's `AutoReleaseSkipReason`. */
export type ManifestPersistSkipReason = "opted-out" | "run-not-successful" | "no-manifest";

export type ManifestPersistResult =
  | { persisted: true; commit: string; manifestDigest: string }
  | { persisted: false; reason: ManifestPersistSkipReason }
  | { persisted: false; reason: "error"; error: string };

/** Input describing one component's completed run — the manifest-persistence counterpart of ./auto-release.ts's `AutoReleaseRunInfo`. */
export interface ManifestPersistRunInfo {
  /** Whether the run reported overall success. A caller must not call this for a non-terminal/in-progress run — mirrors `AutoReleaseRunInfo.success`. */
  success: boolean;
  /** The component's step records (local executor), used to locate the accumulated manifest via `extractRunManifest`. Mutually exclusive with `manifest`. */
  records?: DriverStepRecord[];
  /** A manifest already resolved by the caller (e.g. a future durable/Temporal path that has its own phaseOutputs-shaped extraction). Takes precedence over `records` when both are given. */
  manifest?: BuildArchiveManifest;
}

/** Opt-out knobs for manifest persistence, mirroring ./auto-release.ts's `AutoReleaseOptions`. */
export interface ManifestPersistOptions {
  /** `--no-release-record` / `chant.config.ts`'s `release.autoRecord: false` also gates manifest persistence — both are "durably record this successful deploy" side effects with the same opt-out story, so one flag/config knob controls both rather than introducing a second, easy-to-forget switch. Default: persistence is ON. */
  disabled?: boolean;
  /** Working directory for the git plumbing calls (tests). */
  cwd?: string;
}

/**
 * After a successful `chant run --components <name> --env <env>` (local
 * executor), persist the run's accumulated `BuildArchiveManifest` (if any)
 * to the durable build-manifest store (../lifecycle/build-ledger-store.ts)
 * and push it — or explain, without throwing, why it didn't. Never called
 * for a failed run, matching `maybeRecordAutoRelease`'s contract exactly.
 *
 * Skips (returns `{ persisted: false, reason }`, never throws):
 *  - `options.disabled` — the opt-out flag/config was set.
 *  - `run.success` false — defensive; callers should not reach here on
 *    failure. A dry-run/failed deploy persists nothing, by construction —
 *    this is also what makes a dry run safe: `chant run --components` never
 *    calls this function at all unless the run actually completed.
 *  - no manifest found in the run's records — a component with no
 *    build-family step (an infra-only/apply-only component, or a
 *    build-less `Publish`-only producer that reused a prior archive) has
 *    nothing to persist. This is the expected common case for most deploys,
 *    not an error.
 *
 * Write/push failures (any error `persistBuildManifest`/`pushLifecycle`
 * throw) are reported as `{ persisted: false, reason: "error", error }`
 * rather than propagated — same "never turn a successful deploy into a
 * failing CLI invocation" contract `maybeRecordAutoRelease` already
 * establishes for release records.
 */
export async function maybePersistBuildManifest(
  run: ManifestPersistRunInfo,
  options: ManifestPersistOptions = {},
): Promise<ManifestPersistResult> {
  if (options.disabled) {
    return { persisted: false, reason: "opted-out" };
  }
  if (!run.success) {
    return { persisted: false, reason: "run-not-successful" };
  }

  const manifest = run.manifest ?? extractRunManifest(run.records ?? []);
  if (!manifest) {
    return { persisted: false, reason: "no-manifest" };
  }

  try {
    const { commit } = await persistBuildManifest(manifest, { cwd: options.cwd });
    await pushLifecycle({ cwd: options.cwd });
    return { persisted: true, commit, manifestDigest: manifest.manifestDigest };
  } catch (err) {
    return { persisted: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
