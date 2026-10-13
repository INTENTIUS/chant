import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fetchCatalogs, snapshotFile, type FetchCatalogsOptions } from "./postgres-fetch";
import { POSTGRES_PINS } from "./postgres-pin";

let dir: string;
const quiet = () => undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-sql-pgfetch-"));
  for (const p of POSTGRES_PINS) copyFileSync(snapshotFile(p.major), snapshotFile(p.major, dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A server stand-in that reports `version` and returns no rows for the rest. */
function stub(version: string, log: string[]): NonNullable<FetchCatalogsOptions["startServer"]> {
  return async (image) => {
    log.push(`start ${image}`);
    return {
      reader: {
        query: async (sql) => {
          if (sql.includes("server_version'), ' ', 1")) return version;
          if (sql.includes("server_version_num")) return 0;
          return sql.includes("drop schema") ? [] : [];
        },
      },
      stop: async () => {
        log.push("stop");
      },
    };
  };
}

describe("where generation gets the Postgres catalogs", () => {
  test("snapshots at their pins are read as they are, and no server is started", async () => {
    const log: string[] = [];
    const catalogs = await fetchCatalogs({ snapshotDir: dir, log: quiet, startServer: stub("1.0", log) });
    expect(catalogs.map((c) => c.version)).toEqual(POSTGRES_PINS.map((p) => p.version));
    expect(log).toEqual([]);
  });

  test("a snapshot behind its pin starts that major's image only, and refuses a server at another version", async () => {
    const file = snapshotFile(17, dir);
    const stale = readFileSync(file, "utf-8").replace('"version": "17.11"', '"version": "17.9"');
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, stale);
    const log: string[] = [];
    await expect(fetchCatalogs({ snapshotDir: dir, log: quiet, startServer: stub("17.9", log) })).rejects.toThrow(
      /Postgres 17 is 17\.9, not the pinned 17\.11/,
    );
    expect(log).toEqual([expect.stringMatching(/^start postgres:17\.11@sha256:/), "stop"]);
    expect(readFileSync(file, "utf-8")).toBe(stale);
  });

  test("a server at the pin rewrites the snapshot", async () => {
    const file = snapshotFile(16, dir);
    rmSync(file);
    const log: string[] = [];
    const catalogs = await fetchCatalogs({ snapshotDir: dir, majors: [16], log: quiet, startServer: stub("16.15", log) });
    expect(catalogs.find((c) => c.version === "16.15")?.types).toEqual([]);
    expect(readFileSync(file, "utf-8")).toContain('"version": "16.15"');
    expect(log).toHaveLength(2);
  });

  test("force reads only the majors named", async () => {
    const log: string[] = [];
    await expect(
      fetchCatalogs({ snapshotDir: dir, force: true, majors: [18], log: quiet, startServer: stub("18.6", log) }),
    ).resolves.toHaveLength(5);
    expect(log).toEqual([expect.stringContaining("postgres:18.6@"), "stop"]);
    expect(readdirSync(dir)).toHaveLength(5);
  });
});
