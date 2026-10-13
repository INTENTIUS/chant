/**
 * Where generation gets the ClickHouse catalog.
 *
 * The committed snapshot, `clickhouse-catalog.snapshot.json`, is the source
 * every ordinary run reads: a fresh clone, CI and `npm run prepack` generate
 * from it with no Docker and no network. A server is read only when the
 * snapshot cannot serve the pin:
 *
 * - the pin moved (`CLICKHOUSE_VERSION` differs from the snapshot's version),
 * - `force` is set, or
 * - `CHANT_SQL_CLICKHOUSE_URL` names a server to read instead of starting one.
 *
 * Reading a server means starting the pinned image in a throwaway container
 * (or using the named one), checking that its `version()` is the pin, reading
 * `system.*`, and rewriting the snapshot. A server at any other version is
 * refused: a snapshot labelled with one pin and holding another's surface is
 * the failure the pin exists to prevent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLICKHOUSE_VERSION, clickhouseImage } from "./pin";
import { parseCatalog, readCatalog, stringifyCatalog, type ClickHouseCatalog } from "./catalog";
import { startScratchServer } from "../clickhouse/container";
import type { ClickHouseEndpoint } from "../clickhouse/http";

export const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "clickhouse-catalog.snapshot.json");

/** The key the single catalog document is filed under in the pipeline's schema map. */
export const CATALOG_KEY = "ClickHouse::Catalog";

export interface FetchCatalogOptions {
  /** Read a server even when the snapshot matches the pin. */
  force?: boolean;
  /** A running server to read instead of starting the pinned image. Defaults to `CHANT_SQL_CLICKHOUSE_URL`. */
  serverUrl?: string;
  /** The snapshot to read and rewrite. Tests point it elsewhere. */
  snapshotFile?: string;
  /** Log a line saying which route was taken. */
  log?: (line: string) => void;
}

function readSnapshot(file: string): ClickHouseCatalog | undefined {
  try {
    return parseCatalog(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Read the pinned catalog from a server and refuse any other version. */
export async function catalogFromServer(endpoint: ClickHouseEndpoint, image: string): Promise<ClickHouseCatalog> {
  const catalog = await readCatalog(endpoint, image);
  if (catalog.version !== CLICKHOUSE_VERSION) {
    throw new Error(
      `the server at ${endpoint.url} is ClickHouse ${catalog.version}, not the pinned ${CLICKHOUSE_VERSION}. ` +
        "Point CHANT_SQL_CLICKHOUSE_URL at a server running the pin, or update CLICKHOUSE_IMAGE_DIGEST in src/spec/pin.ts " +
        "together with CLICKHOUSE_VERSION.",
    );
  }
  return catalog;
}

/**
 * The catalog for the current pin: the snapshot when it matches, otherwise a
 * fresh read that also rewrites the snapshot.
 */
export async function fetchCatalog(options: FetchCatalogOptions = {}): Promise<ClickHouseCatalog> {
  const file = options.snapshotFile ?? SNAPSHOT_FILE;
  const log = options.log ?? ((line: string) => console.error(line));
  const serverUrl = options.serverUrl ?? process.env.CHANT_SQL_CLICKHOUSE_URL;
  const snapshot = readSnapshot(file);

  if (snapshot && snapshot.version === CLICKHOUSE_VERSION && !options.force && !serverUrl) {
    log(`[sql] clickhouse catalog: committed snapshot at ${snapshot.version}`);
    return snapshot;
  }

  const reason = !snapshot
    ? "no readable snapshot"
    : snapshot.version !== CLICKHOUSE_VERSION
      ? `the pin moved from ${snapshot.version} to ${CLICKHOUSE_VERSION}`
      : serverUrl
        ? "CHANT_SQL_CLICKHOUSE_URL is set"
        : "force";

  let catalog: ClickHouseCatalog;
  if (serverUrl) {
    log(`[sql] clickhouse catalog: reading ${serverUrl} (${reason})`);
    catalog = await catalogFromServer({ url: serverUrl }, clickhouseImage());
  } else {
    const image = clickhouseImage();
    log(`[sql] clickhouse catalog: starting ${image} (${reason})`);
    const server = await startScratchServer(image, { namePrefix: "chant-sql-catalog" });
    try {
      catalog = await catalogFromServer(server.endpoint, image);
    } finally {
      await server.stop();
    }
  }

  writeFileSync(file, stringifyCatalog(catalog));
  log(`[sql] clickhouse catalog: wrote ${file}`);
  return catalog;
}

/** The pipeline's `fetchSchemas`: one document, the catalog, keyed {@link CATALOG_KEY}. */
export async function fetchSchemas(options: FetchCatalogOptions = {}): Promise<Map<string, Buffer>> {
  const catalog = await fetchCatalog(options);
  return new Map([[CATALOG_KEY, Buffer.from(stringifyCatalog(catalog), "utf-8")]]);
}
