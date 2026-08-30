import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { helmInputDigest } from "../../render-digest";
import { loadRenderContent, loadRenderManifest, renderStoreRoot, type RenderManifest } from "../../render-store";
import { routeRender } from "../../render-wrapper";
import { materializeWrapperChart } from "../../wrapper-chart";
import {
  ClusterProbeError,
  compareCapabilityProfile,
  probeClusterCapabilities,
} from "./cluster-probe";
import { safeHeartbeat } from "@intentius/chant/op";
import {
  maybeRecordAutoRelease,
  type AutoReleaseResult,
} from "@intentius/chant/components/auto-release";

const execAsync = promisify(exec);

/**
 * The cluster capability profile a deploy is declared against (epic #1228).
 * Declared, never sniffed — the epic's finding 1 shows the default kube
 * version is a property of the helm binary, so an undeclared profile cannot
 * be part of a stable identity. When declared it joins the input digest.
 */
export interface HelmCapabilityProfile {
  /** The profile's declared name (its `helm.capabilityProfiles` key), used in assertion messages. Not part of the digest — only the declared facts are. */
  name?: string;
  /** Kubernetes version the render targets (`--kube-version`). */
  kubeVersion?: string;
  /** Extra API versions the render assumes (`--api-versions`). Order-insensitive for the digest. */
  apiVersions?: string[];
}

export interface HelmInstallArgs {
  /** Helm release name. */
  name: string;
  /**
   * Chart reference (local path or `repo/chart`). Required for an unpinned
   * deploy; refused alongside `contentDigest` — a pinned deploy's bytes come
   * from the render store, never from a deploy-time render.
   */
  chart?: string;
  /**
   * `sha256:` content digest of a stored pinned render (#1242). When set,
   * the deploy takes the pinned path: the recorded render is loaded from the
   * render store, its digest verified, and those exact bytes installed as a
   * structure-preserving wrapper chart — no deploy-time render. The chart /
   * values / set / chartVersion render inputs are refused in this mode.
   */
  contentDigest?: string;
  /** Render store root override for the pinned path (tests, non-default stores). Defaults to `CHANT_HELM_RENDER_ROOT` / `~/.chant/helm-renders`. */
  renderStoreRoot?: string;
  /** Chart version to pin (`--version`). Part of the input digest. */
  chartVersion?: string;
  /** Path to a values file. */
  values?: string;
  /** Kubernetes namespace. Defaults to the stored render's namespace on the pinned path. */
  namespace?: string;
  /** Additional --set arguments. */
  set?: Record<string, string>;
  /** Capability profile the deploy is declared against, if any. Part of the input digest when declared, and asserted against the live target cluster before any helm mutation (#1244). */
  capabilityProfile?: HelmCapabilityProfile;
  /**
   * Deliberate escape hatch for the capability-profile assertion (#1244).
   * When the live cluster diverges from the declared profile — or cannot be
   * probed at all — the deploy normally refuses before any helm mutation.
   * Set `true` to deploy anyway; the bypassed divergences are warned about
   * and recorded in the release record (`profileOverride`), so the ledger
   * shows the release knowingly skewed from its declared profile. Has no
   * effect when the cluster matches, and none when no profile is declared.
   */
  overrideProfileAssertion?: boolean;
  /** Component name for the release record. Defaults to the release `name` — a chart's release is its deploy unit. */
  component?: string;
  /** Environment for the release record. Defaults to `"local"`, the same default `chant run --components` applies. */
  env?: string;
  /** Run id for the release record. Defaults to `$GITHUB_RUN_ID`/`$CI_PIPELINE_ID`, then a locally generated id — the same fallback chain `chant components release` uses. */
  runId?: string;
  /** Set `false` to skip release-record emission, mirroring `--no-release-record`. Default: emission is ON. */
  recordRelease?: boolean;
}

/** What `helmInstall` returns: the input digest and the release-record outcome, so a workflow can carry both. */
export interface HelmInstallResult {
  /**
   * `sha256:` digest over the deploy's *inputs* — chart, chart version,
   * resolved values, capability profile if declared (#1243). This is the
   * input-side join key: two environments deploying the same chart at the
   * same version with the same values share it even when their clusters
   * legitimately differ. It is deliberately not a rendered-output digest —
   * that is the pinned-render work of later #1228 phases. Absent only when
   * the digest could not be computed (see `release.reason`).
   */
  inputDigest?: string;
  /** Outcome of the ledger append — `recorded: true` carries the `ReleaseRecord` written. */
  release: AutoReleaseResult;
  /**
   * Outcome of the deploy-time capability-profile assertion (#1244). Present
   * exactly when the deploy declared a profile with assertable facts (on the
   * pinned path the stored render's profile always is one). A mismatch
   * without the override never reaches a result — the activity throws before
   * any helm mutation — so a present outcome is either a verified match or a
   * deliberate, recorded override.
   */
  profileAssertion?: HelmProfileAssertionOutcome;
  /** Helm release name the deploy targeted (`args.name`). */
  releaseName: string;
  /** Namespace the deploy targeted, or `null` when helm's default applied. */
  namespace: string | null;
  /**
   * True when this deploy took the pinned path (#1242): recorded bytes
   * loaded from the render store, digest-verified, installed as a wrapper
   * chart with no deploy-time render.
   */
  pinned: boolean;
  /**
   * `sha256:` content digest of the installed render — the artifact identity
   * (the epic's `renderDigest`, named for the #1237 split). Pinned path only:
   * an unpinned deploy has no rendered-output identity to report.
   */
  contentDigest?: string;
  /**
   * Release revision after the deploy, from `helm get metadata -o json`.
   * Pinned path only, and absent when the metadata read failed after a
   * successful install (best-effort, like the ledger append).
   */
  revision?: number;
  /** Chart version installed — `helm get metadata`'s `version`, falling back to the stored render's. Pinned path only. */
  chartVersion?: string | null;
  /** Number of CRD documents shipped in the wrapper's `crds/` (uninstall-safe; epic finding 4). Pinned path only. */
  crdsApplied?: number;
  /** Number of non-CRD documents installed through the wrapper's templates (hook documents included). Pinned path only. */
  docsApplied?: number;
  /** Number of hook documents among `docsApplied` — helm registers and runs them from their recorded annotations (epic finding 5). Pinned path only. */
  hooksRun?: number;
}

/** Thrown by the pinned path (#1242) when `contentDigest` resolves to nothing in the render store. */
export class PinnedRenderNotFoundError extends Error {
  constructor(contentDigest: string, root: string) {
    super(
      `pinned install refused: render ${contentDigest} is not in the render store at ${root}. ` +
        `Nothing was deployed. A pinned deploy installs recorded bytes; render and persist the chart ` +
        `first (HelmRender with a capabilityProfile), or check the digest against \`listRenderManifests\`.`,
    );
    this.name = "PinnedRenderNotFoundError";
  }
}

/** Thrown by the pinned path (#1242) when the stored bytes no longer hash to their digest — store corruption, caught before any mutation. */
export class PinnedRenderIntegrityError extends Error {
  constructor(contentDigest: string, actual: string) {
    super(
      `pinned install refused: stored bytes for ${contentDigest} hash to ${actual} — the render store ` +
        `entry is corrupt. Nothing was deployed. Re-render to repopulate the store; a digest that does ` +
        `not match its bytes must never reach a cluster.`,
    );
    this.name = "PinnedRenderIntegrityError";
  }
}

/** Thrown by the pinned path (#1242) when the call mixes pinned and unpinned inputs, or targets a release name the bytes were not rendered for. */
export class PinnedInstallInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedInstallInputError";
  }
}

/**
 * Thrown by the pinned path (#1242) when the deploy's declared capability
 * profile disagrees with the profile recorded in the stored render's
 * manifest. Distinct from `CapabilityProfileMismatchError` (#1244, declared
 * vs *live cluster*): this is declared vs *recorded*, checked first and
 * entirely offline.
 */
export class PinnedProfileMismatchError extends Error {
  constructor(release: string, contentDigest: string, divergences: string[]) {
    super(
      `pinned install refused: release "${release}" declares a capability profile that does not match ` +
        `the one render ${contentDigest} was pinned against:\n` +
        divergences.map((d) => `  - ${d}`).join("\n") +
        `\nThe stored bytes are only accurate for the profile they were rendered for. Deploy them ` +
        `against that profile, or re-render for this one. Nothing was deployed.`,
    );
    this.name = "PinnedProfileMismatchError";
  }
}

/** How the deploy-time profile assertion (#1244) concluded, when a profile was declared. */
export type HelmProfileAssertionOutcome =
  | { matched: true }
  | { matched: false; divergences: string[]; overridden: true };

/**
 * Thrown before any helm mutation when the target cluster does not match the
 * deploy's declared capability profile (#1244). The message names every
 * divergence — declared vs live — so the refusal is specific, never a shrug.
 */
export class CapabilityProfileMismatchError extends Error {
  constructor(
    release: string,
    profileName: string | undefined,
    public readonly divergences: string[],
  ) {
    const profile = profileName ? ` "${profileName}"` : "";
    super(
      `helm release "${release}": target cluster does not match the declared capability profile${profile}:\n` +
        divergences.map((d) => `  - ${d}`).join("\n") +
        `\nThe deploy's identity was pinned against the declared profile; deploying to a diverging cluster ` +
        `breaks the per-cluster guarantee that the same rendered bytes reach every cluster sharing a profile. ` +
        `Fix the profile or retarget the deploy — or pass overrideProfileAssertion: true for a deliberate ` +
        `override, which is recorded in the release record. Nothing was deployed.`,
    );
    this.name = "CapabilityProfileMismatchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge one `--set key=value` entry into `values` at its dotted path,
 * helm's precedence (set wins over the file). Helm's backslash escaping for
 * literal dots in keys is not interpreted — the digest needs a deterministic
 * shape, not a re-implementation of helm's parser, and an escaped key still
 * digests deterministically, just under its split form.
 */
function applySetEntry(values: Record<string, unknown>, path: string, value: string): void {
  const segments = path.split(".");
  let node = values;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * The resolved values a deploy will hand to helm: the parsed values file
 * (when given) with `--set` entries applied on top. A values file that does
 * not parse to a mapping contributes nothing — helm itself rejects such a
 * file at deploy time, so the digest never sees it succeed.
 */
function resolveValues(args: HelmInstallArgs): Record<string, unknown> {
  const parsed = args.values ? load(readFileSync(args.values, "utf8")) : undefined;
  const values: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  for (const [path, value] of Object.entries(args.set ?? {})) applySetEntry(values, path, value);
  return values;
}

/**
 * The input-side identity of a helm deploy (#1243): a `sha256:` digest over
 * the canonical JSON of `{ chart, chartVersion, values, capabilityProfile? }`.
 * Canonical JSON (core's `canonicalJson`, RFC 8785 shape) sorts object keys,
 * so the digest is stable across value key order; `apiVersions` is sorted
 * for the same reason. The digest changes when any actual input changes —
 * the chart, its version, a value, the declared profile.
 *
 * Delegates to `helmInputDigest` (#1237) — the same helper `HelmRender`
 * records as a pinned render's `inputDigest` — so a deploy and a render of
 * the same inputs share their identity by construction.
 */
export function helmInstallInputDigest(args: HelmInstallArgs): string {
  if (!args.chart) {
    throw new Error(
      `cannot compute an input digest for release "${args.name}": no chart reference. ` +
        `A pinned deploy carries its digests in the stored RenderManifest instead.`,
    );
  }
  return helmInputDigest({
    chart: args.chart,
    chartVersion: args.chartVersion,
    values: resolveValues(args),
    capabilityProfile: args.capabilityProfile,
  });
}

/**
 * Assert the target cluster matches the deploy's declared capability profile
 * (#1244), before any helm mutation. Returns the assertion outcome, or
 * `undefined` when there was nothing to assert (no profile, or a profile
 * declaring no facts) — that path never touches kubectl, keeping the
 * no-profile deploy exactly what it was.
 *
 * A mismatch throws `CapabilityProfileMismatchError` naming every divergence.
 * An unprobeable cluster throws too — a deploy that cannot verify its
 * guarantee must not silently proceed. `overrideProfileAssertion: true`
 * turns both refusals into a warned, recorded override.
 */
async function assertCapabilityProfile(
  args: HelmInstallArgs,
  signal?: AbortSignal,
): Promise<HelmProfileAssertionOutcome | undefined> {
  const profile = args.capabilityProfile;
  if (!profile || (!profile.kubeVersion && !(profile.apiVersions?.length))) return undefined;

  let divergences: string[];
  try {
    const live = await probeClusterCapabilities(signal);
    divergences = compareCapabilityProfile(profile, live);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!args.overrideProfileAssertion) {
      throw new ClusterProbeError(
        `helm release "${args.name}": the deploy declares capability profile` +
          `${profile.name ? ` "${profile.name}"` : ""} but the target cluster's capabilities could not ` +
          `be verified — ${why}. A deploy that cannot verify its declared profile does not proceed. ` +
          `Nothing was deployed. Pass overrideProfileAssertion: true only for a deliberate override.`,
      );
    }
    divergences = [`capability probe failed: ${why}`];
  }

  if (divergences.length === 0) return { matched: true };
  if (!args.overrideProfileAssertion) {
    throw new CapabilityProfileMismatchError(args.name, profile.name, divergences);
  }
  console.error(
    `warning: helm release "${args.name}" deploying despite capability profile` +
      `${profile.name ? ` "${profile.name}"` : ""} divergence (overrideProfileAssertion):\n` +
      divergences.map((d) => `  - ${d}`).join("\n") +
      `\nThe override is recorded in the release record.`,
  );
  return { matched: false, divergences, overridden: true };
}

/**
 * Append the deploy's release record, best-effort (#1243). Called only after
 * `helm upgrade --install` succeeded — a failed deploy writes nothing, by
 * construction, because this function is never reached.
 *
 * Reuses `maybeRecordAutoRelease` — the same field resolution the
 * `chant run --components` post-run step applies (actor from
 * `GITHUB_ACTOR`/`GITLAB_USER_LOGIN`/`USER`, git sha from `HEAD`, timestamp
 * taken at record time, append + push to the `chant/lifecycle` orphan
 * branch). A field that cannot be resolved here (e.g. no git repo in a
 * worker container) is never faked: the append is skipped and the skip is
 * warned about, exactly as the convention's error path behaves.
 */
async function recordHelmRelease(
  args: HelmInstallArgs,
  digest: string | undefined,
  digestError: string | undefined,
  profileOverride: string | undefined,
  inputDigest?: string,
): Promise<AutoReleaseResult> {
  if (args.recordRelease === false) return { recorded: false, reason: "opted-out" };
  if (!digest) {
    return { recorded: false, reason: "error", error: digestError ?? "input digest unavailable" };
  }
  const runId =
    args.runId ?? process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? `local-${Date.now()}`;
  return maybeRecordAutoRelease({
    component: args.component ?? args.name,
    env: args.env ?? "local",
    success: true,
    digest,
    runId,
    profileOverride,
    inputDigest,
  });
}

/**
 * Deploy a helm release and append a `ReleaseRecord` (#1243).
 *
 * Two paths, selected by `contentDigest`:
 *
 * - **Unpinned** (no `contentDigest`): `helm upgrade --install <name>
 *   <chart>`, exactly as before #1242 — helm renders at deploy time. The
 *   ledger record is keyed by the input digest.
 * - **Pinned** (`contentDigest` set, #1242): the recorded render is loaded
 *   from the render store, its digest verified, and those exact bytes
 *   installed as a structure-preserving wrapper chart — no deploy-time
 *   render. The ledger record is keyed by the content digest and carries
 *   the stored render's input digest alongside it.
 *
 * A ledger-append failure after a successful deploy warns and never throws:
 * the deploy already happened, so a ledger-write hiccup must not turn a
 * finished deploy into a failed activity — the record is observability, not
 * part of the deploy itself.
 *
 * Uses longInfra profile — 20m timeout, heartbeat every 15s.
 */
export async function helmInstall(
  args: HelmInstallArgs,
  signal?: AbortSignal,
): Promise<HelmInstallResult> {
  if (args.contentDigest) return pinnedHelmInstall(args, args.contentDigest, signal);
  if (!args.chart) {
    throw new PinnedInstallInputError(
      `helm release "${args.name}": no chart reference and no contentDigest — pass \`chart\` for an ` +
        `unpinned deploy, or \`contentDigest\` to install a recorded pinned render. Nothing was deployed.`,
    );
  }

  // The digest is computed over the same bytes the deploy reads, before the
  // deploy runs. A compute failure (unreadable values file, unrepresentable
  // value) must not block the deploy — helm gives the authoritative error —
  // so it is carried into the record outcome instead of thrown here.
  let inputDigest: string | undefined;
  let digestError: string | undefined;
  try {
    inputDigest = helmInstallInputDigest(args);
  } catch (err) {
    digestError = `could not compute input digest: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Deploy-time profile assertion (#1244): when a profile is declared, the
  // live cluster must match it before helm mutates anything. A refusal (or
  // an unprobeable cluster) throws here, so no helm command has run yet.
  const profileAssertion = await assertCapabilityProfile(args, signal);

  const parts = ["helm", "upgrade", "--install", "--wait", args.name, args.chart];
  if (args.chartVersion) parts.push("--version", args.chartVersion);
  if (args.namespace) parts.push("--namespace", args.namespace, "--create-namespace");
  if (args.values) parts.push("-f", args.values);
  for (const [k, v] of Object.entries(args.set ?? {})) parts.push("--set", `${k}=${v}`);

  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "helm install", release: args.name });
  }, 15_000);

  try {
    const { stdout, stderr } = await execAsync(parts.join(" "), { signal });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
  }

  const profileOverride =
    profileAssertion && !profileAssertion.matched ? profileAssertion.divergences.join("; ") : undefined;
  const release = await recordHelmRelease(args, inputDigest, digestError, profileOverride);
  if (!release.recorded && release.reason !== "opted-out") {
    const why =
      release.reason === "error"
        ? release.error
        : `${release.reason}${release.detail ? ` — ${release.detail}` : ""}`;
    console.error(
      `warning: helm release "${args.name}" deployed, but no release record was appended (${why}). ` +
        `The deploy succeeded; the ledger write is best-effort observability and never fails a finished deploy.`,
    );
  }
  return {
    inputDigest,
    release,
    ...(profileAssertion ? { profileAssertion } : {}),
    releaseName: args.name,
    namespace: args.namespace ?? null,
    pinned: false,
  };
}

/**
 * The pinned install path (#1242): deploy a recorded render's exact bytes.
 *
 * Refusals, all before any helm mutation, each with its own error type:
 * mixed pinned/unpinned inputs (`PinnedInstallInputError`), digest not in
 * the store (`PinnedRenderNotFoundError`), stored bytes not hashing to
 * their digest (`PinnedRenderIntegrityError`), a declared profile
 * disagreeing with the recorded one (`PinnedProfileMismatchError`), a
 * release name the bytes were not rendered for
 * (`PinnedInstallInputError` — `.Release.Name` is baked into the bytes),
 * and the #1244 live-cluster assertion, which on this path always runs
 * against the *manifest's* profile — a stored render is pinned by
 * construction, so the deploy always has a profile to verify.
 *
 * The install input is a structure-preserving wrapper chart materialized
 * from the routed render (`routeRender` over the stored bytes — the #1239
 * seam): CRD-origin documents in `crds/` (uninstall-safe, epic finding 4),
 * everything else shipped verbatim through `.Files.Get` shims so no byte is
 * re-templated. `helm history` / `helm rollback` keep working — the wrapper
 * inherits the source chart's name and version, and the release is a normal
 * helm release.
 */
async function pinnedHelmInstall(
  args: HelmInstallArgs,
  contentDigest: string,
  signal?: AbortSignal,
): Promise<HelmInstallResult> {
  const renderInputs: string[] = (["chart", "chartVersion", "values"] as const).filter(
    (k) => args[k] !== undefined,
  );
  if (args.set && Object.keys(args.set).length > 0) renderInputs.push("set");
  if (renderInputs.length > 0) {
    throw new PinnedInstallInputError(
      `pinned install refused: release "${args.name}" passes contentDigest together with ` +
        `deploy-time render input(s) ${renderInputs.map((k) => `\`${k}\``).join(", ")}. A pinned deploy ` +
        `installs the recorded bytes of ${contentDigest} — chart, values, set and chartVersion were ` +
        `closed at render time and cannot be re-opened here. Drop them, or drop contentDigest for an ` +
        `unpinned deploy. Nothing was deployed.`,
    );
  }

  const storeOpts = args.renderStoreRoot ? { root: args.renderStoreRoot } : undefined;
  const manifest = loadRenderManifest(contentDigest, storeOpts);
  const content = manifest ? loadRenderContent(contentDigest, storeOpts) : undefined;
  if (!manifest || content === undefined) {
    throw new PinnedRenderNotFoundError(contentDigest, args.renderStoreRoot ?? renderStoreRoot());
  }

  // Verify before any mutation: the stored bytes are the digest's preimage
  // (the store writes canonical bytes under their own hash), so a mismatch
  // means the entry was corrupted or tampered with after it was written.
  const actual = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  if (actual !== contentDigest) throw new PinnedRenderIntegrityError(contentDigest, actual);

  if (args.name !== manifest.releaseName) {
    throw new PinnedInstallInputError(
      `pinned install refused: render ${contentDigest} was rendered for release ` +
        `"${manifest.releaseName}" but the deploy targets release "${args.name}". \`.Release.Name\` is ` +
        `baked into the recorded bytes (labels, resource names), so installing them under another name ` +
        `deploys bytes that claim a different release. Deploy under "${manifest.releaseName}", or ` +
        `render for "${args.name}". Nothing was deployed.`,
    );
  }

  assertDeclaredProfileMatchesManifest(args, contentDigest, manifest);

  // The #1244 live-cluster assertion, against the profile the bytes were
  // actually rendered for — the RenderManifest's, not the caller's (the two
  // were just proven to agree where the caller declared one).
  const profileAssertion = await assertCapabilityProfile(
    {
      ...args,
      capabilityProfile: {
        name: manifest.capabilityProfile.cluster,
        kubeVersion: manifest.capabilityProfile.kubeVersion,
        apiVersions: manifest.capabilityProfile.apiVersions,
      },
    },
    signal,
  );

  const namespace = args.namespace ?? manifest.namespace ?? undefined;
  if (args.namespace && manifest.namespace && args.namespace !== manifest.namespace) {
    console.error(
      `warning: pinned release "${args.name}" deploys to namespace "${args.namespace}" but was ` +
        `rendered for "${manifest.namespace}" — documents that bake in \`.Release.Namespace\` will ` +
        `carry the rendered value.`,
    );
  }

  const routed = routeRender(content, { chart: manifest.chart, chartVersion: manifest.chartVersion });
  for (const warning of routed.warnings) {
    console.error(`warning: pinned release "${args.name}": ${warning.message}`);
  }

  const wrapperDir = mkdtempSync(join(tmpdir(), "chant-helm-pinned-"));
  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "helm install (pinned)", release: args.name });
  }, 15_000);
  try {
    materializeWrapperChart(routed, wrapperDir);
    const parts = ["helm", "upgrade", "--install", "--wait", args.name, wrapperDir];
    if (namespace) parts.push("--namespace", namespace, "--create-namespace");
    const { stdout, stderr } = await execAsync(parts.join(" "), { signal });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
    rmSync(wrapperDir, { recursive: true, force: true });
  }

  // Revision from helm's own bookkeeping (`helm get metadata -o json`) —
  // best-effort after a successful install, like the ledger append: a
  // metadata read hiccup must not fail a finished deploy.
  let revision: number | undefined;
  let chartVersion: string | null = manifest.chartVersion;
  try {
    const metaParts = ["helm", "get", "metadata", args.name, "-o", "json"];
    if (namespace) metaParts.push("--namespace", namespace);
    const { stdout } = await execAsync(metaParts.join(" "), { signal });
    const meta = JSON.parse(stdout) as { revision?: unknown; version?: unknown };
    const parsed = Number(meta.revision);
    if (Number.isFinite(parsed)) revision = parsed;
    if (typeof meta.version === "string" && meta.version.length > 0) chartVersion = meta.version;
  } catch (err) {
    console.error(
      `warning: pinned release "${args.name}" deployed, but \`helm get metadata\` failed ` +
        `(${err instanceof Error ? err.message : String(err)}); the result carries no revision.`,
    );
  }

  const profileOverride =
    profileAssertion && !profileAssertion.matched ? profileAssertion.divergences.join("; ") : undefined;
  // Pinned deploys record the content digest — what this cluster actually
  // received — with the stored render's input digest alongside as the
  // cross-environment join key (epic Decisions: profiles are per cluster,
  // so bytes legitimately differ across environments; inputs do not).
  const release = await recordHelmRelease(args, contentDigest, undefined, profileOverride, manifest.inputDigest);
  if (!release.recorded && release.reason !== "opted-out") {
    const why =
      release.reason === "error"
        ? release.error
        : `${release.reason}${release.detail ? ` — ${release.detail}` : ""}`;
    console.error(
      `warning: helm release "${args.name}" deployed, but no release record was appended (${why}). ` +
        `The deploy succeeded; the ledger write is best-effort observability and never fails a finished deploy.`,
    );
  }

  return {
    inputDigest: manifest.inputDigest,
    release,
    ...(profileAssertion ? { profileAssertion } : {}),
    releaseName: args.name,
    namespace: namespace ?? null,
    pinned: true,
    contentDigest,
    revision,
    chartVersion,
    crdsApplied: routed.crds.length,
    docsApplied: routed.main.length + routed.hooks.length,
    hooksRun: routed.hooks.length,
  };
}

/**
 * Offline half of the pinned profile check: when the deploy itself declares
 * a capability profile, its facts must agree with the profile recorded in
 * the stored render's manifest — same kubeVersion, declared apiVersions all
 * among the recorded set. A caller that declares nothing defers entirely to
 * the manifest.
 */
function assertDeclaredProfileMatchesManifest(
  args: HelmInstallArgs,
  contentDigest: string,
  manifest: RenderManifest,
): void {
  const declared = args.capabilityProfile;
  if (!declared) return;
  const recorded = manifest.capabilityProfile;
  const divergences: string[] = [];
  if (declared.kubeVersion && declared.kubeVersion !== recorded.kubeVersion) {
    divergences.push(
      `kubeVersion: deploy declares ${declared.kubeVersion}, render was pinned against ${recorded.kubeVersion}`,
    );
  }
  const recordedApis = new Set(recorded.apiVersions);
  for (const apiVersion of declared.apiVersions ?? []) {
    if (!recordedApis.has(apiVersion)) {
      divergences.push(`apiVersion ${apiVersion}: declared by the deploy, absent from the render's recorded profile`);
    }
  }
  if (divergences.length > 0) {
    throw new PinnedProfileMismatchError(args.name, contentDigest, divergences);
  }
}
