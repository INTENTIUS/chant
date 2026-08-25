/**
 * Live-cluster capability probe for the deploy-time profile assertion
 * (#1244, epic #1228 phase 4).
 *
 * A render pinned for one capability profile and deployed to a cluster with
 * another is silently skewed: the bytes were computed against a declared
 * `kubeVersion` and `apiVersions` set, and nothing at deploy time checked
 * the target actually matches. This module reads the target cluster's real
 * capabilities — `kubectl version -o json` for the server version,
 * `kubectl api-versions` for the served API set — through the same
 * exec-and-ambient-kubeconfig convention `helmInstall` already uses for the
 * helm binary, and names every divergence from a declared profile.
 *
 * The comparison tolerance is deliberate: kubeVersion matches on
 * major.minor. A profile declaring `1.33.6` matches a live `v1.33.4+k3s1` —
 * the capability surface helm renders against (`.Capabilities.KubeVersion`)
 * is a major.minor fact, and patch skew within a minor changes no API
 * surface a chart can probe. Declared apiVersions are exact-match: each one
 * the profile names must be served by the cluster.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** What the probe read off the live cluster. */
export interface LiveClusterCapabilities {
  /** The server's full version string (`serverVersion.gitVersion`), e.g. `v1.33.6+k3s1`. */
  kubeVersion: string;
  /** The server's `major.minor`, e.g. `1.33`, parsed from `serverVersion.major`/`minor` (or `gitVersion` when those are absent). */
  majorMinor: string;
  /** Every API version the cluster serves, one `group/version` (or `v1`) per entry, from `kubectl api-versions`. */
  apiVersions: string[];
}

/**
 * Thrown when the cluster's capabilities cannot be read at all — kubectl
 * missing, cluster unreachable, or unparseable output. A deploy that
 * declared a profile cannot verify its guarantee through this error, so the
 * caller must refuse to proceed rather than deploy blind.
 */
export class ClusterProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterProbeError";
  }
}

/** `major.minor` from a declared or live version string (`1.33`, `1.33.6`, `v1.33.6+k3s1`). Undefined when the string has no parseable major.minor. */
export function majorMinorOf(version: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function parseServerVersion(raw: string): { kubeVersion: string; majorMinor: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClusterProbeError(`kubectl version -o json produced unparseable output: ${raw.slice(0, 200)}`);
  }
  const server = (parsed as { serverVersion?: Record<string, unknown> }).serverVersion;
  if (!server) {
    throw new ClusterProbeError(
      "kubectl version -o json reported no serverVersion — the cluster did not answer",
    );
  }
  const gitVersion = typeof server.gitVersion === "string" ? server.gitVersion : "";
  // major/minor are the authoritative fields; minor can carry a vendor
  // suffix (GKE reports "33+"), so digits are extracted rather than trusted.
  const major = typeof server.major === "string" ? /\d+/.exec(server.major)?.[0] : undefined;
  const minor = typeof server.minor === "string" ? /\d+/.exec(server.minor)?.[0] : undefined;
  const majorMinor = major && minor ? `${major}.${minor}` : gitVersion ? majorMinorOf(gitVersion) : undefined;
  if (!majorMinor) {
    throw new ClusterProbeError(
      `kubectl version -o json reported no usable server version (gitVersion: ${gitVersion || "<absent>"})`,
    );
  }
  return { kubeVersion: gitVersion || majorMinor, majorMinor };
}

/**
 * Read the target cluster's capabilities. Uses whatever kubeconfig/context
 * the process environment provides — the same ambient target `helm upgrade`
 * itself will act on, so the probe and the deploy see one cluster.
 */
export async function probeClusterCapabilities(signal?: AbortSignal): Promise<LiveClusterCapabilities> {
  let versionRaw: string;
  let apiVersionsRaw: string;
  try {
    const [versionResult, apiResult] = await Promise.all([
      execAsync("kubectl version -o json", { signal }),
      execAsync("kubectl api-versions", { signal }),
    ]);
    versionRaw = versionResult.stdout;
    apiVersionsRaw = apiResult.stdout;
  } catch (err) {
    throw new ClusterProbeError(
      `could not read the target cluster's capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { kubeVersion, majorMinor } = parseServerVersion(versionRaw);
  const apiVersions = apiVersionsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { kubeVersion, majorMinor, apiVersions };
}

/** The declared facts a profile asserts about a cluster — the activity-side profile shape. */
export interface DeclaredCapabilityProfile {
  name?: string;
  kubeVersion?: string;
  apiVersions?: string[];
}

/**
 * Every way `live` diverges from what `profile` declares, one message per
 * divergence, each naming the declared and the live value. Empty when the
 * cluster matches the profile.
 *
 * kubeVersion compares on major.minor (see module doc). apiVersions is a
 * subset check: everything the profile declares must be served; extra API
 * versions on the cluster are not a divergence, since a render only ever
 * probed the declared set.
 */
export function compareCapabilityProfile(
  profile: DeclaredCapabilityProfile,
  live: LiveClusterCapabilities,
): string[] {
  const divergences: string[] = [];
  if (profile.kubeVersion) {
    const declared = majorMinorOf(profile.kubeVersion);
    if (declared !== live.majorMinor) {
      divergences.push(
        `kubeVersion: profile declares ${profile.kubeVersion} (${declared ?? "unparseable"}), ` +
          `cluster runs ${live.kubeVersion} (${live.majorMinor})`,
      );
    }
  }
  const served = new Set(live.apiVersions);
  for (const apiVersion of profile.apiVersions ?? []) {
    if (!served.has(apiVersion)) {
      divergences.push(`apiVersion ${apiVersion}: declared by the profile, not served by the cluster`);
    }
  }
  return divergences;
}
