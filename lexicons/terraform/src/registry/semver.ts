/**
 * The versions a module registry lists: plain `major.minor.patch`, with an
 * optional leading `v` on input. Lifted from terragucci's `publish/semver.ts`
 * (18f6431595), cut to what the registry protocol needs (chant#4565).
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(text: string): Semver | undefined {
  const m = RE.exec(text.trim());
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]! } : undefined;
}

export const formatSemver = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`;

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The newest of a list of versions; entries that are not versions are skipped. */
export function newest(versions: string[]): Semver | undefined {
  let best: Semver | undefined;
  for (const v of versions) {
    const p = parseSemver(v);
    if (p && (!best || compareSemver(p, best) > 0)) best = p;
  }
  return best;
}
