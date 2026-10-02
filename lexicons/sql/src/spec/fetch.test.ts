import { createServer, type Server } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchCatalog, SNAPSHOT_FILE } from "./fetch";
import { CLICKHOUSE_VERSION } from "./pin";
import { parseCatalog, stringifyCatalog } from "./catalog";

/** A stand-in for a server's HTTP interface: answers `version()` and returns no rows for the rest. */
function fakeServer(version: string): Promise<{ url: string; server: Server; queries: string[] }> {
  const queries: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      queries.push(body);
      res.end(body.includes("version()") ? `${JSON.stringify({ v: version })}\n` : "");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, server, queries });
    }),
  );
}

let dir: string;
const quiet = () => undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-sql-fetch-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("where generation gets the catalog", () => {
  test("a snapshot at the pin is read as is, and nothing is started", async () => {
    const file = join(dir, "at-pin.json");
    copyFileSync(SNAPSHOT_FILE, file);
    const lines: string[] = [];
    const catalog = await fetchCatalog({ snapshotFile: file, serverUrl: undefined, log: (l) => lines.push(l) });
    expect(catalog.version).toBe(CLICKHOUSE_VERSION);
    expect(lines.join("\n")).toContain("committed snapshot");
  });

  test("a server at a version other than the pin is refused, and the snapshot is left alone", async () => {
    const file = join(dir, "moved.json");
    const old = { ...parseCatalog(readFileSync(SNAPSHOT_FILE, "utf-8")), version: "26.3.39.7" };
    writeFileSync(file, stringifyCatalog(old));
    const before = readFileSync(file, "utf-8");

    const fake = await fakeServer("26.9.8.3");
    try {
      await expect(fetchCatalog({ snapshotFile: file, serverUrl: fake.url, log: quiet })).rejects.toThrow(
        /is ClickHouse 26\.9\.8\.3, not the pinned/,
      );
    } finally {
      fake.server.close();
    }
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  test("a server at the pin is read and the snapshot rewritten from it", async () => {
    const file = join(dir, "refresh.json");
    writeFileSync(file, "{}");
    const fake = await fakeServer(CLICKHOUSE_VERSION);
    try {
      const catalog = await fetchCatalog({ snapshotFile: file, serverUrl: fake.url, log: quiet });
      expect(catalog.version).toBe(CLICKHOUSE_VERSION);
      expect(fake.queries.some((q) => q.includes("FROM system.table_engines ORDER BY name"))).toBe(true);
      expect(parseCatalog(readFileSync(file, "utf-8")).version).toBe(CLICKHOUSE_VERSION);
    } finally {
      fake.server.close();
    }
  });
});
