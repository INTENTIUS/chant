/**
 * Digests recorded before real SHA-256 (chant #2514).
 *
 * Up to chant 0.80.0, `contentDigest` labelled its output `sha256:` but
 * computed a 32-bit string hash and repeated its 8 hex digits eight times.
 * It now computes real SHA-256 (../content-digest.ts), so every value it
 * produces changed once. Values already recorded in a project's release
 * ledger or persisted build manifests keep the old form: they are never
 * re-keyed or rewritten, because a digest is an identity other records point
 * at.
 *
 * Readers accept both forms. A record read back with an old value carries
 * `flags: ["legacy-digest"]`, computed on read and never written, and chant
 * warns once per project, per process, that the ledger holds such values.
 * Both forms stay accepted through {@link LEGACY_DIGEST_ACCEPTED_THROUGH}.
 * A later release may stop accepting old values, and it will warn a release
 * ahead, as #2525 requires of any level-0 change.
 *
 * An old value is recognisable by its shape alone. A real SHA-256 hex digest
 * whose 64 characters are one 8-character block repeated eight times has
 * probability 2^-224, so the check has no false positives worth considering.
 */

import { resolve } from "node:path";

const LEGACY_DIGEST = /^sha256:([0-9a-f]{8})\1{7}$/;

/** The flag a record read back with an old-form digest carries. */
export const LEGACY_DIGEST_FLAG = "legacy-digest";
export type LegacyDigestFlag = typeof LEGACY_DIGEST_FLAG;

/**
 * The last release series in which readers are guaranteed to accept old-form
 * digests: every 0.8x release. The first release allowed to refuse them is
 * 0.90.0, and only after a release that warns about it.
 */
export const LEGACY_DIGEST_ACCEPTED_THROUGH = "0.89.x";

/** Whether `value` is a `sha256:` string made by the old 32-bit `contentDigest`. */
export function isLegacyContentDigest(value: unknown): boolean {
  return typeof value === "string" && LEGACY_DIGEST.test(value);
}

/** Whether any of `values` is an old-form digest. */
export function hasLegacyContentDigest(values: Iterable<unknown>): boolean {
  for (const value of values) {
    if (isLegacyContentDigest(value)) return true;
  }
  return false;
}

/**
 * `record` with `flags: ["legacy-digest"]` added when any of `values` (the
 * record's own digests) is in the old form, and otherwise unchanged. Other
 * flags a record carries are kept.
 */
export function flagLegacyDigest<T extends { flags?: string[] }>(record: T, values: Iterable<unknown>): T {
  if (!hasLegacyContentDigest(values)) return record;
  const flags = record.flags ?? [];
  if (flags.includes(LEGACY_DIGEST_FLAG)) return record;
  return { ...record, flags: [...flags, LEGACY_DIGEST_FLAG] };
}

/**
 * `record` without its read-side `flags`, for writers. Flags describe how a
 * record reads now, so they are never persisted.
 */
export function withoutReadFlags<T extends { flags?: unknown }>(record: T): Omit<T, "flags"> {
  if (!("flags" in record)) return record;
  const { flags: _flags, ...rest } = record;
  return rest;
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
  if (!hasLegacyContentDigest(values)) return false;
  warnedProjects.add(project);
  console.warn(
    `[chant] warning: this project's ${where} ${where === "release ledger" ? "holds" : "hold"} sha256: values made by chant's old 32-bit content hash, ` +
      "not real SHA-256. chant now computes real SHA-256, so a digest recorded from now on will not match " +
      "an old one for the same content. Old entries are not rewritten: they read back flagged legacy-digest, " +
      `and chant accepts them through ${LEGACY_DIGEST_ACCEPTED_THROUGH}. See https://github.com/INTENTIUS/chant/issues/2514`,
  );
  return true;
}
