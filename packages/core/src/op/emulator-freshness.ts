/**
 * How far behind an emulator's pinned image is (#1345, generalizing #808 T2).
 *
 * This began as `lexicons/fly/src/emulator-freshness.ts`, checking fly's two
 * pins against their GitHub releases. The other three emulators — Floci for aws,
 * floci-az, floci-gcp — ran `:latest`, so there was nothing to be behind and
 * nothing to check: an image could change underneath a passing local test suite
 * with no record in the repo of what moved.
 *
 * With the pin and its upstream declared on {@link EmulatorSpec}, the check
 * covers every emulator any lexicon ships, and a new one is included by
 * declaring `upstream` rather than by editing a list here.
 *
 * Advisory, never gating. Per the bump policy (#808) a pin moves when a
 * consuming test needs the newer emulator, not because a release happened.
 */

import type { EmulatorSpec } from "./emulator-lifecycle";

export interface FreshnessResult {
  /** The emulator's container name, e.g. `chant-mudflaps`. */
  name: string;
  /** Pinned version, no leading `v`. */
  pinned: string;
  /** Latest released version, no leading `v`. */
  latest: string;
  /** True when the latest release is newer than the pin. */
  behind: boolean;
}

/** The version tag of an image ref (`ghcr.io/x/mudflaps:0.3.1` → `0.3.1`). */
export function parseVersion(image: string): string {
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  // A registry port (`localhost:5000/x`) is not a tag.
  if (lastColon < 0 || lastColon < lastSlash) return "";
  return image.slice(lastColon + 1).replace(/^v/, "");
}

function toParts(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

/** Compare pinned against latest as dotted numeric versions. */
export function compare(name: string, pinned: string, latest: string): FreshnessResult {
  const p = toParts(pinned);
  const l = toParts(latest);
  let behind = false;
  for (let i = 0; i < Math.max(p.length, l.length); i++) {
    const a = p[i] ?? 0;
    const b = l[i] ?? 0;
    if (b > a) {
      behind = true;
      break;
    }
    if (b < a) break;
  }
  return { name, pinned: pinned.replace(/^v/, ""), latest: latest.replace(/^v/, ""), behind };
}

/** The latest release tag for a repo, via the GitHub REST API. */
export async function latestRelease(repo: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`releases/latest ${repo}: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error(`releases/latest ${repo}: no tag_name`);
  return body.tag_name;
}

/**
 * Check every spec that declares an upstream. A spec without one is skipped
 * rather than reported — an emulator built from a local image has no release
 * feed to be behind.
 */
export async function checkFreshness(
  specs: readonly EmulatorSpec[],
  fetchImpl: typeof fetch = fetch,
): Promise<FreshnessResult[]> {
  const pinned = specs.filter((s) => s.upstream?.repo && parseVersion(s.image));
  return Promise.all(
    pinned.map(async (s) =>
      compare(s.name, parseVersion(s.image), await latestRelease(s.upstream!.repo, fetchImpl)),
    ),
  );
}

/** One-line human summary of a result. */
export function formatResult(r: FreshnessResult): string {
  return r.behind
    ? `⚠ ${r.name}: pinned ${r.pinned}, latest ${r.latest} — behind`
    : `✓ ${r.name}: pinned ${r.pinned} is current (latest ${r.latest})`;
}

/** Emulator images that carry no version tag — `:latest` or none at all. */
export function unpinned(specs: readonly EmulatorSpec[]): EmulatorSpec[] {
  return specs.filter((s) => {
    const version = parseVersion(s.image);
    return version === "" || version === "latest";
  });
}
