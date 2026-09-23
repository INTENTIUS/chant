/**
 * The warning a release ahead of real SHA-256 digests (chant #2514).
 *
 * `contentDigest` (../components/verbs/build-archive.ts) labels its output
 * `sha256:` but computes a 32-bit string hash and repeats its 8 hex digits
 * eight times. The next release makes it real SHA-256, so every value it
 * produces changes once. Values already recorded in a project's release
 * ledger or persisted build manifests keep the old form. This release only
 * says so: readers of those records warn once per project, per process, when
 * they meet an old value. Nothing is rewritten or flagged yet.
 *
 * An old value is recognisable by its shape alone. A real SHA-256 hex digest
 * whose 64 characters are one 8-character block repeated eight times has
 * probability 2^-224, so the check has no false positives worth considering.
 */

import { resolve } from "node:path";

const LEGACY_DIGEST = /^sha256:([0-9a-f]{8})\1{7}$/;

/** Whether `value` is a `sha256:` string made by the old 32-bit `contentDigest`. */
export function isLegacyContentDigest(value: unknown): boolean {
  return typeof value === "string" && LEGACY_DIGEST.test(value);
}

/** Project roots already warned about in this process. */
const warnedProjects = new Set<string>();

/** Forget which projects were warned about. For tests. */
export function resetLegacyDigestWarnings(): void {
  warnedProjects.clear();
}

/**
 * Warn once for the project at `cwd` (default: the working directory) when
 * any of `values` is an old-form digest. `where` names the record that held
 * it, for the message. Returns whether a warning was printed.
 */
export function warnOnLegacyDigests(
  values: Iterable<unknown>,
  where: "release ledger" | "build manifests",
  cwd?: string,
): boolean {
  const project = resolve(cwd ?? process.cwd());
  if (warnedProjects.has(project)) return false;
  let found = false;
  for (const value of values) {
    if (isLegacyContentDigest(value)) {
      found = true;
      break;
    }
  }
  if (!found) return false;
  warnedProjects.add(project);
  console.warn(
    `[chant] warning: this project's ${where} ${where === "release ledger" ? "holds" : "hold"} sha256: values made by chant's old 32-bit content hash, ` +
      "not real SHA-256. The next chant release computes real SHA-256, so digests recorded from then on " +
      "will not match these for the same content. Existing entries stay readable and will be marked " +
      "legacy-digest. See https://github.com/INTENTIUS/chant/issues/2514",
  );
  return true;
}
