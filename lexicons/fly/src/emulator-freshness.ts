/**
 * Emulator-freshness check (#808 T2, second half).
 *
 * mudflaps (Machines) and spritzer (Sprites) are pinned to a single source
 * (./op/activities/emulator-images.ts). Their upstream repos cut GitHub releases,
 * so this compares each pinned tag against the latest release and reports how far
 * behind it is. A weekly workflow surfaces a "N releases behind" notice — never
 * an auto-bump. Per the bump policy (#808), the tag moves only when a consuming
 * test needs the newer emulator, so this is advisory, not gating on the pin.
 */

import { MUDFLAPS_IMAGE, SPRITZER_IMAGE } from "./op/activities/emulator-images";

export interface EmulatorPin {
  /** Short name, e.g. "mudflaps". */
  name: string;
  /** GitHub repo "owner/name" whose releases publish the emulator. */
  repo: string;
  /** Pinned version, no leading "v" (e.g. "0.3.1"). */
  pinned: string;
}

export interface FreshnessResult {
  name: string;
  pinned: string;
  latest: string;
  /** True when the latest release is newer than the pinned version. */
  behind: boolean;
}

/** Parse the version tag from a ghcr image ref (".../mudflaps:0.3.1" → "0.3.1"). */
export function parseVersion(image: string): string {
  const tag = image.slice(image.lastIndexOf(":") + 1);
  return tag.replace(/^v/, "");
}

function toParts(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

/** Compare pinned vs latest as dotted numeric versions; `behind` when latest > pinned. */
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

/** The emulator pins to check, read from the single-source image constants. */
export const EMULATOR_PINS: readonly EmulatorPin[] = [
  { name: "mudflaps", repo: "intentius/mudflaps", pinned: parseVersion(MUDFLAPS_IMAGE) },
  { name: "spritzer", repo: "intentius/spritzer", pinned: parseVersion(SPRITZER_IMAGE) },
] as const;

/** Fetch the latest release tag for a repo via the GitHub REST API. */
export async function latestRelease(repo: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`releases/latest ${repo}: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error(`releases/latest ${repo}: no tag_name`);
  return body.tag_name;
}

/** Check every emulator pin against its latest release. */
export async function checkFreshness(fetchImpl: typeof fetch = fetch): Promise<FreshnessResult[]> {
  return Promise.all(
    EMULATOR_PINS.map(async (p) => compare(p.name, p.pinned, await latestRelease(p.repo, fetchImpl))),
  );
}

/** One-line human summary of a result. */
export function formatResult(r: FreshnessResult): string {
  return r.behind
    ? `⚠ ${r.name}: pinned ${r.pinned}, latest ${r.latest} — behind`
    : `✓ ${r.name}: pinned ${r.pinned} is current (latest ${r.latest})`;
}
