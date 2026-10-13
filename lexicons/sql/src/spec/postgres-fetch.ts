/**
 * Where generation gets the Postgres catalogs.
 *
 * The committed snapshots, `postgres-catalog-<major>.snapshot.json`, are the
 * source every ordinary run reads: a fresh clone, CI and `npm run prepack`
 * generate from them with no Docker and no network. A server is read, one per
 * major, only when a snapshot cannot serve its pin:
 *
 * - the major's pin moved (its `version` in `postgres-pin.ts` differs from the
 *   snapshot's) or the snapshot is missing or unreadable, or
 * - `force` is set.
 *
 * Reading a server means starting that major's image by tag and digest in a
 * throwaway container, checking that its `server_version` is the pin, reading
 * the catalog, and rewriting the snapshot. A server at any other version is
 * refused: a snapshot labelled with one pin and holding another's surface is
 * the failure the pin exists to prevent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_PINS, postgresImage, postgresPin, type PostgresPin } from "./postgres-pin";
import { parseCatalog, readCatalog, stringifyCatalog, type PostgresCatalog, type PostgresReader } from "./postgres-catalog";
import { startScratchPostgres } from "../postgres/container";

const specDir = dirname(fileURLToPath(import.meta.url));

/** The committed snapshot of one major. */
export const snapshotFile = (major: number, dir: string = specDir): string =>
  join(dir, `postgres-catalog-${major}.snapshot.json`);

export interface FetchCatalogsOptions {
  /** Read a server even when the snapshot matches the pin. */
  force?: boolean;
  /** Only these majors (the default is all). */
  majors?: readonly number[];
  /** The directory holding the snapshots. Tests point it elsewhere. */
  snapshotDir?: string;
  /** Start the server for a major. Tests stub it; the default runs the pinned image. */
  startServer?: (image: string) => Promise<{ reader: PostgresReader; stop(): Promise<void> }>;
  /** Log a line saying which route was taken. */
  log?: (line: string) => void;
}

function readSnapshot(file: string): PostgresCatalog | undefined {
  try {
    return parseCatalog(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Read one pin's catalog from a server and refuse any other version. */
export async function catalogFromServer(reader: PostgresReader, pin: PostgresPin, image: string): Promise<PostgresCatalog> {
  const catalog = await readCatalog(reader, image);
  if (catalog.version !== pin.version) {
    throw new Error(
      `the server for Postgres ${pin.major} is ${catalog.version}, not the pinned ${pin.version}. ` +
        `Run the pinned image, or update the ${pin.major} line of src/spec/postgres-pin.ts: version and digest together.`,
    );
  }
  return catalog;
}

const defaultStart: NonNullable<FetchCatalogsOptions["startServer"]> = async (image) => {
  const server = await startScratchPostgres(image, { namePrefix: "chant-sql-pg-catalog" });
  return {
    reader: { query: async (sql) => JSON.parse((await server.psql(sql)).trim()) as unknown },
    stop: server.stop,
  };
};

/**
 * The catalogs for the current pins, oldest major first: each snapshot that
 * matches its pin, and a fresh read (which rewrites the snapshot) for each
 * that does not. Servers run one at a time.
 */
export async function fetchCatalogs(options: FetchCatalogsOptions = {}): Promise<PostgresCatalog[]> {
  const log = options.log ?? ((line: string) => console.error(line));
  const start = options.startServer ?? defaultStart;
  const wanted = options.majors ?? POSTGRES_PINS.map((p) => p.major);
  const catalogs: PostgresCatalog[] = [];
  for (const pin of POSTGRES_PINS) {
    const file = snapshotFile(pin.major, options.snapshotDir);
    const snapshot = readSnapshot(file);
    const read = wanted.includes(pin.major);
    if (snapshot && snapshot.version === pin.version && !(options.force && read)) {
      log(`[sql] postgres ${pin.major} catalog: committed snapshot at ${snapshot.version}`);
      catalogs.push(snapshot);
      continue;
    }
    const reason = !snapshot
      ? "no readable snapshot"
      : snapshot.version !== pin.version
        ? `the pin moved from ${snapshot.version} to ${pin.version}`
        : "force";
    const image = postgresImage(pin.major);
    log(`[sql] postgres ${pin.major} catalog: starting ${image} (${reason})`);
    const server = await start(image);
    let catalog: PostgresCatalog;
    try {
      catalog = await catalogFromServer(server.reader, postgresPin(pin.major), image);
    } finally {
      await server.stop();
    }
    writeFileSync(file, stringifyCatalog(catalog));
    log(`[sql] postgres ${pin.major} catalog: wrote ${file}`);
    catalogs.push(catalog);
  }
  return catalogs;
}
