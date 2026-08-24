import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { canonicalJson } from "@intentius/chant/effect-receipt";
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
  /** Kubernetes version the render targets (`--kube-version`). */
  kubeVersion?: string;
  /** Extra API versions the render assumes (`--api-versions`). Order-insensitive for the digest. */
  apiVersions?: string[];
}

export interface HelmInstallArgs {
  /** Helm release name. */
  name: string;
  /** Chart reference (local path or `repo/chart`). */
  chart: string;
  /** Chart version to pin (`--version`). Part of the input digest. */
  chartVersion?: string;
  /** Path to a values file. */
  values?: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** Additional --set arguments. */
  set?: Record<string, string>;
  /** Capability profile the deploy is declared against, if any. Part of the input digest when declared. */
  capabilityProfile?: HelmCapabilityProfile;
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
 */
export function helmInstallInputDigest(args: HelmInstallArgs): string {
  const input: Record<string, unknown> = {
    chart: args.chart,
    chartVersion: args.chartVersion ?? null,
    values: resolveValues(args),
  };
  if (args.capabilityProfile) {
    input.capabilityProfile = {
      kubeVersion: args.capabilityProfile.kubeVersion ?? null,
      apiVersions: [...(args.capabilityProfile.apiVersions ?? [])].sort(),
    };
  }
  return `sha256:${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
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
  inputDigest: string | undefined,
  digestError: string | undefined,
): Promise<AutoReleaseResult> {
  if (args.recordRelease === false) return { recorded: false, reason: "opted-out" };
  if (!inputDigest) {
    return { recorded: false, reason: "error", error: digestError ?? "input digest unavailable" };
  }
  const runId =
    args.runId ?? process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? `local-${Date.now()}`;
  return maybeRecordAutoRelease({
    component: args.component ?? args.name,
    env: args.env ?? "local",
    success: true,
    digest: inputDigest,
    runId,
  });
}

/**
 * Run `helm upgrade --install <name> <chart>`, then append a `ReleaseRecord`
 * keyed by the deploy's input digest (#1243).
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

  const release = await recordHelmRelease(args, inputDigest, digestError);
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
  return { inputDigest, release };
}
