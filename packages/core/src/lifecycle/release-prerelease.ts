/**
 * Prerelease labels. A release whose label is a semver prerelease
 * (`1.4.0-rc.1`, `v2.0.0-beta.3`) is a prerelease on every publish target
 * without a `--channel`: npm moves a dist-tag named for the prerelease id
 * and never `latest`, a GitHub or Forgejo release is marked a prerelease,
 * and an OCI image keeps no `latest` tag. A channel named on the cut still
 * decides the npm dist-tag and the OCI tag.
 */

const SEMVER_PRERELEASE = /^v?\d+\.\d+\.\d+-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z.-]+)?$/;

/** What a prerelease label says: its id (`rc`) and the npm dist-tag it maps to. */
export interface Prerelease {
  /** The first dot-separated identifier after the hyphen, such as `rc` or `beta`; null when it is a number. */
  id: string | null;
  /** The npm dist-tag a reveal moves: the id lowercased, or `next` when there is no usable id. */
  distTag: string;
}

/** The prerelease a label is, or null for a plain version or no label. */
export function prereleaseOf(label: string | null | undefined): Prerelease | null {
  if (!label) return null;
  const m = SEMVER_PRERELEASE.exec(label);
  if (!m) return null;
  const first = m[1]!.split(".")[0]!.toLowerCase();
  const numeric = /^[0-9]+$/.test(first);
  const id = numeric ? null : first;
  // `latest` is the tag a prerelease must never move.
  return { id, distTag: id === null || id === "latest" ? "next" : id };
}

/** One line for a prerelease label: where a publish sends it. `channel` is the tag a cut named, which wins over the id. */
export function prereleaseNote(label: string | null | undefined, channel?: string | null): string {
  const pre = prereleaseOf(label);
  if (!pre) return "";
  const tag = channel || pre.distTag;
  return `${label} is a prerelease: npm moves ${tag}, not latest; a GitHub or Forgejo release is marked a prerelease; an OCI image keeps no latest tag`;
}
