import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CATALOG_SECTIONS, normalizeDefault, parseCatalog, stringifyCatalog, summaryOf } from "./catalog";
import { SNAPSHOT_FILE } from "./fetch";
import { CLICKHOUSE_VERSION, clickhouseImage, versionFromReleaseTag } from "./pin";

const snapshotText = readFileSync(SNAPSHOT_FILE, "utf-8");

describe("the committed ClickHouse catalog snapshot", () => {
  const catalog = parseCatalog(snapshotText);

  test("is at the pin, read from the pinned image", () => {
    expect(catalog.version).toBe(CLICKHOUSE_VERSION);
    expect(catalog.image).toBe(clickhouseImage());
  });

  test("is written exactly as stringifyCatalog writes it, so a pin move is a line diff", () => {
    expect(stringifyCatalog(catalog)).toBe(snapshotText);
  });

  test("keeps every section sorted by name", () => {
    for (const section of CATALOG_SECTIONS) {
      const names = (catalog[section] as Array<string | { name: string }>).map((r) => (typeof r === "string" ? r : r.name));
      expect(names, section).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
  });

  test("holds no host-dependent default", () => {
    expect(snapshotText).not.toMatch(/auto\(\d+\)/);
  });
});

describe("catalog normalization", () => {
  test("auto(<cores>) becomes auto", () => {
    expect(normalizeDefault("auto(12)")).toBe("auto");
    expect(normalizeDefault("8192")).toBe("8192");
  });

  test("a summary is the first prose line of the markdown", () => {
    expect(summaryOf("## Heading\n\n```sql\nSELECT 1\n```\nThe first line.\nThe second.")).toBe("The first line.");
    expect(summaryOf("\n\nThe first line.\nThe second.")).toBe("The first line.");
    expect(summaryOf("x".repeat(300))).toHaveLength(200);
  });

  test("parseCatalog names the section a broken snapshot is missing", () => {
    const broken = JSON.parse(snapshotText);
    delete broken.codecs;
    expect(() => parseCatalog(JSON.stringify(broken))).toThrow(/codecs/);
  });
});

describe("the pin", () => {
  test("a GitHub LTS tag reads as the bare version", () => {
    expect(versionFromReleaseTag("v26.8.15.10-lts")).toBe("26.8.15.10");
  });
});
