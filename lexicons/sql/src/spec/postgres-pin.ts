/**
 * The pinned Postgres servers the Postgres dialect's types come from.
 *
 * Postgres publishes no schema for its DDL either. Types, access methods,
 * operator classes, settings, keywords, function names and extensions are read
 * from a running server's catalog (chant #3277), so a pin is a server image.
 * One snapshot per supported major, 14 to 18 (14 leaves community support in
 * November 2026, and dropping it is deleting its entry and its snapshot), and
 * the generated types are the union of the five with a `since` and an `until`
 * major on every entry that is not in all of them.
 *
 * Each entry pins an exact minor by tag and by digest. The type surface does
 * not move between minors (17.9 against 17.11 differs by one setting), but a
 * floating `18` tag would change generated output with no commit, and a
 * re-pushed tag must not change it unseen either: generation runs
 * `image@digest` and refuses a server whose `server_version` is not the
 * entry's version. The digest is the multi-arch manifest list's.
 *
 * Moving a pin: change that major's `version` and `digest` on its one line,
 * then `chant dev generate` (or `npm run generate`). The committed snapshot no
 * longer matches, so generation starts that image, rewrites
 * `src/spec/postgres-catalog-<major>.snapshot.json`, and the pull request's
 * diff of that file is the surface change. Read its `-` lines: a removed
 * setting or function is what breaks declarations. Adding a major is one more
 * line here and one more snapshot.
 *
 * The lines are written one per major, in this exact shape, because
 * {@link postgresUpstreamPin} finds a major's version with a regular
 * expression over its line.
 */

import type { UpstreamPin } from "@intentius/chant/lexicon";

export interface PostgresPin {
  /** The major, as `server_version_num / 10000`. */
  major: number;
  /** The exact minor, as `server_version` reports it with the Debian build suffix removed, and the docker tag. */
  version: string;
  /** The image digest of `postgres:<version>`. Move it with the version. */
  digest: string;
}

/** The official server image. */
export const POSTGRES_IMAGE_REPOSITORY = "postgres";

/** One pin per supported major, oldest first. */
export const POSTGRES_PINS: readonly PostgresPin[] = [
  { major: 14, version: "14.24", digest: "sha256:c2427de38f998489d36de7ca3553db2134872c400f2b08be4b824e5c50e4d619" },
  { major: 15, version: "15.19", digest: "sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550" },
  { major: 16, version: "16.15", digest: "sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54" },
  { major: 17, version: "17.11", digest: "sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f" },
  { major: 18, version: "18.6", digest: "sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722" },
];

/** The supported majors, oldest first. */
export const POSTGRES_MAJORS: readonly number[] = POSTGRES_PINS.map((p) => p.major);

/** The latest supported major: the emulator image and the default for a project that names no version. */
export const POSTGRES_LATEST_MAJOR = POSTGRES_MAJORS[POSTGRES_MAJORS.length - 1]!;

export function postgresPin(major: number): PostgresPin {
  const pin = POSTGRES_PINS.find((p) => p.major === major);
  if (!pin) throw new Error(`Postgres ${major} is not a supported major (${POSTGRES_MAJORS.join(", ")})`);
  return pin;
}

/** The full image reference generation runs: tag for the reader, digest for the runtime. */
export function postgresImage(major: number): string {
  const pin = postgresPin(major);
  return `${POSTGRES_IMAGE_REPOSITORY}:${pin.version}@${pin.digest}`;
}

/**
 * `postgres/postgres` publishes no GitHub releases, only tags: `REL_18_6`,
 * `REL_18_BETA1`, `REL_18_RC1`, `REL9_6_24`, `Release_2_0`. A stable release
 * maps to `18.6`; every other spelling is skipped.
 */
export function versionFromReleaseTag(tag: string): string | null {
  const m = /^REL_(\d+)_(\d+)$/.exec(tag);
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * The `upstreamPin` descriptor for one major's line in this file. A plugin
 * holds a single `upstreamPin` (the sql plugin's is ClickHouse's), so these
 * are exported for the Postgres upgrade tooling to dispatch over rather than
 * attached to the plugin: each tracks only its own major (`trackMajor`), so
 * the 17 pin reports `17.12` and never `18.6`.
 */
export function postgresUpstreamPin(major: number): UpstreamPin {
  postgresPin(major);
  return {
    file: "src/spec/postgres-pin.ts",
    pattern: new RegExp(`\\{ major: ${major}, version: "([^"]+)"`),
    replace: (v: string, line: string) =>
      line.replace(/version: "[^"]+"/, `version: "${versionFromReleaseTag(v) ?? v}"`),
    alsoMoves: `the digest on the same line of src/spec/postgres-pin.ts moves with the version: set version to the new minor, set digest to that tag's image digest (docker buildx imagetools inspect postgres:<version>), then run \`chant dev generate\` and read the diff of src/spec/postgres-catalog-${major}.snapshot.json. A git tag lands a few days before its image tag, so the report can name a version that has no image yet.`,
    upstream: { owner: "postgres", repo: "postgres", kind: "tags", tagVersion: versionFromReleaseTag, trackMajor: true },
  };
}
