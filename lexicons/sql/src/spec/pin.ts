/**
 * The pinned ClickHouse server the ClickHouse dialect's types come from.
 *
 * ClickHouse publishes no schema for its DDL. The engine names, column type
 * families, codecs, skip index types and both settings surfaces are read from a
 * running server's `system.*` tables (chant #3195), so the pin is a server
 * image, not a document.
 *
 * Pinned to an exact patch of the 26.8 LTS line. 26.3 LTS lacks the `syntax`
 * column on `system.table_engines` and the `system.data_skipping_index_types`
 * table the engine-argument and skip-index types are built from, and two
 * patches of one line differ (26.8.5.13 and 26.8.15.10 differ by nine query
 * settings), so a floating `26.8` tag would change generated output with no
 * commit. The digest sits beside the tag so a re-pushed tag cannot change it
 * unseen either: generation runs `image@digest` and refuses a server whose
 * `version()` is not {@link CLICKHOUSE_VERSION}.
 *
 * Moving the pin: change both constants, then `chant dev generate` (or
 * `npm run generate`). The committed snapshot no longer matches the pin, so
 * generation starts the pinned server, rewrites
 * `src/spec/clickhouse-catalog.snapshot.json`, and the pull request's diff of
 * that file is the surface change. Read its `-` lines: a removed engine or
 * function is what breaks a user's declarations.
 */

/** The pinned `clickhouse-server` release, as `SELECT version()` reports it. */
export const CLICKHOUSE_VERSION = "26.8.15.10";

/** The image digest of `clickhouse/clickhouse-server:<CLICKHOUSE_VERSION>`. Move it with the version. */
export const CLICKHOUSE_IMAGE_DIGEST = "sha256:9716a352d25f538bd19d868b001141e7a60e4d035bc9b823658c6a071660aa61";

/** The official server image. */
export const CLICKHOUSE_IMAGE_REPOSITORY = "clickhouse/clickhouse-server";

/** The full image reference generation runs: tag for the reader, digest for the runtime. */
export function clickhouseImage(): string {
  return `${CLICKHOUSE_IMAGE_REPOSITORY}:${CLICKHOUSE_VERSION}@${CLICKHOUSE_IMAGE_DIGEST}`;
}

/**
 * ClickHouse tags its LTS releases `v<version>-lts` on GitHub. The upgrade
 * tooling hands `replace` the raw tag; the constant holds the bare version,
 * which is also the docker tag.
 */
export function versionFromReleaseTag(tag: string): string {
  return tag.replace(/^v/, "").replace(/-lts$/, "");
}
