import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseCatalog, type ClickHouseCatalog } from "../spec/catalog";
import { SNAPSHOT_FILE } from "../spec/fetch";
import { renderClickHouseModule, settingTsType } from "./clickhouse-module";

const load = (): ClickHouseCatalog => parseCatalog(readFileSync(SNAPSHOT_FILE, "utf-8"));

describe("rendering the generated ClickHouse module", () => {
  const rendered = renderClickHouseModule(load());

  test("is deterministic", () => {
    expect(renderClickHouseModule(load())).toEqual(rendered);
  });

  test("declares the engine union and the settings interfaces", () => {
    expect(rendered.declarations).toContain('export const CLICKHOUSE_VERSION = "26.8.15.10";');
    expect(rendered.declarations).toMatch(/export type MergeTreeEngineName = [^;]*"ReplacingMergeTree"/);
    expect(rendered.declarations).toContain("export interface MergeTreeSettings {");
    expect(rendered.declarations).toMatch(/\n {2}index_granularity\?: number;/);
  });

  test("merges the overlay's argument kinds into the engine table", () => {
    const line = rendered.tables.split("\n").find((l) => l.startsWith("  ReplacingMergeTree:"))!;
    const spec = JSON.parse(line.slice(line.indexOf("{"), -1));
    expect(spec.typed).toBe(true);
    expect(spec.args.map((a: { name: string; kind: string; optional: boolean }) => [a.name, a.kind, a.optional])).toEqual([
      ["ver", "column", true],
      ["is_deleted", "column", true],
    ]);
  });

  test("leaves every MergeTree engine typed", () => {
    expect(rendered.notes.filter((n) => n.includes("MergeTree"))).toEqual([]);
  });

  test("refuses an overlay argument the syntax line no longer has", () => {
    const catalog = load();
    const engine = catalog.tableEngines.find((e) => e.name === "CollapsingMergeTree")!;
    engine.syntax = "ENGINE = CollapsingMergeTree(sign_column) ORDER BY expr";
    expect(() => renderClickHouseModule(catalog)).toThrow(/CollapsingMergeTree: overlay argument "sign"/);
  });

  test("refuses a codec the overlay has no entry for", () => {
    const catalog = load();
    catalog.codecs.push({ ...catalog.codecs[0]!, name: "Brand_New" });
    expect(() => renderClickHouseModule(catalog)).toThrow(/codec Brand_New .* has no entry/);
  });

  test("refuses an overlay engine the pin no longer ships", () => {
    const catalog = load();
    catalog.tableEngines = catalog.tableEngines.filter((e) => e.name !== "Buffer");
    expect(() => renderClickHouseModule(catalog)).toThrow(/engine Buffer is not in the catalog/);
  });
});

describe("setting types", () => {
  test("map to TypeScript, and an enum-typed setting is a string", () => {
    expect(settingTsType("Bool")).toBe("boolean");
    expect(settingTsType("UInt64Auto")).toBe('number | "auto"');
    expect(settingTsType("MergeSelectorAlgorithm")).toBe("string");
  });
});
