import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CATALOG_SECTIONS, majorOf, parseCatalog, stringifyCatalog } from "./postgres-catalog";
import { snapshotFile } from "./postgres-fetch";
import { POSTGRES_PINS } from "./postgres-pin";

const read = (major: number) => readFileSync(snapshotFile(major), "utf-8");

describe.each(POSTGRES_PINS.map((p) => [p.major, p.version, p.digest] as const))("the %i snapshot", (major, version, digest) => {
  const text = read(major);
  const catalog = parseCatalog(text);

  test("is the pinned version, read from the pinned image", () => {
    expect(catalog.version).toBe(version);
    expect(majorOf(catalog.version)).toBe(major);
    expect(catalog.versionNum).toBe(Number(`${major}${version.split(".")[1]!.padStart(4, "0")}`));
    expect(catalog.image).toBe(`postgres:${version}@${digest}`);
  });

  test("round-trips to the same bytes, one entry per line", () => {
    expect(stringifyCatalog(catalog)).toBe(text);
    expect(text.split("\n").length).toBeGreaterThan(3000);
  });

  test("has every section, sorted by name", () => {
    for (const section of CATALOG_SECTIONS) expect(catalog[section].length).toBeGreaterThan(0);
    const names = catalog.settings.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(catalog.settings.some((s) => s.name.startsWith("server_version"))).toBe(false);
  });

  test("records the storage parameters the server accepts", () => {
    expect(catalog.storageParameters.table).toContain("fillfactor");
    expect(catalog.storageParameters["index:gin"]).toContain("fastupdate");
  });
});

describe("parseCatalog", () => {
  test("refuses another dialect's catalog and a missing section", () => {
    expect(() => parseCatalog('{"dialect":"clickhouse"}')).toThrow(/not a Postgres catalog/);
    expect(() => parseCatalog('{"dialect":"postgres","version":"18.6"}')).toThrow(/section types/);
  });
});
