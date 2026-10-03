import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { renderPostgresModule } from "./postgres-module";
import { parseCatalog, type PostgresCatalog } from "../spec/postgres-catalog";
import { snapshotFile } from "../spec/postgres-fetch";
import { POSTGRES_MAJORS } from "../spec/postgres-pin";
import { availableAt } from "../postgres/catalog-types";

const load = (): PostgresCatalog[] => POSTGRES_MAJORS.map((m) => parseCatalog(readFileSync(snapshotFile(m), "utf-8")));
const rendered = renderPostgresModule(load());

describe("the Postgres union", () => {
  test("is byte-identical across runs", () => {
    const again = renderPostgresModule(load());
    expect(again.declarations).toBe(rendered.declarations);
    expect(again.tables).toBe(rendered.tables);
  });

  test("lists the majors and the exact release each was read from", () => {
    expect(rendered.declarations).toContain("export const POSTGRES_MAJORS = [14,15,16,17,18] as const;");
    expect(rendered.declarations).toContain('"18":"18.6"');
  });

  test("marks what arrived in a later major with since", () => {
    expect(rendered.declarations).toContain('"io_method": { since: 18 }');
    expect(rendered.declarations).toContain('"regexp_count": { since: 15 }');
    expect(rendered.declarations).toMatch(/\/\*\*[^\n]*@since 18 \*\/\n {2}io_method\?: /);
  });

  test("marks what a later major dropped with until, the last major that has it", () => {
    expect(rendered.declarations).toContain('"close_lb": { until: 14 }');
    expect(rendered.declarations).toContain('"old_snapshot_threshold": { until: 16 }');
    expect(rendered.declarations).toMatch(/\/\*\*[^\n]*@until 16 \*\/\n {2}old_snapshot_threshold\?: /);
  });

  test("keeps an entry in every major free of a range", () => {
    const ranges = rendered.declarations.slice(rendered.declarations.indexOf("export const VERSION_RANGES"));
    expect(ranges).not.toContain('"btree"');
    expect(ranges).not.toContain('"index:btree.fillfactor"');
    expect(ranges).toContain('"view.security_invoker": { since: 15 }');
  });

  test("marks the enum members a setting gained", () => {
    expect(rendered.declarations).toMatch(/"wal_compression": \{\n\s+"lz4": \{ since: 15 \}/);
  });

  test("types storage parameters from the overlay, with the major they arrived in", () => {
    expect(rendered.declarations).toMatch(/export interface StorageParams_table \{[^}]*fillfactor\?: number;/);
    expect(rendered.declarations).toMatch(/@since 15 \*\/\n {2}security_invoker\?: boolean;/);
  });

  test("merges the overlay into the column type table", () => {
    expect(rendered.tables).toMatch(/"character varying": \{[^\n]*"parameters":\[\{"name":"length"/);
    expect(rendered.tables).toContain('"aliases":["int","int4"]');
  });

  test("availableAt reads a range", () => {
    expect(availableAt({ since: 15 }, 14)).toBe(false);
    expect(availableAt({ since: 15, until: 16 }, 16)).toBe(true);
    expect(availableAt({ until: 14 }, 15)).toBe(false);
    expect(availableAt(undefined, 14)).toBe(true);
  });
});

describe("the overlays are checked against the catalogs", () => {
  test("a storage parameter the probe found with no overlay entry fails generation", () => {
    const catalogs = load();
    catalogs[4]!.storageParameters.table = [...catalogs[4]!.storageParameters.table!, "brand_new_parameter"];
    expect(() => renderPostgresModule(catalogs)).toThrow(/storage parameter brand_new_parameter has no entry/);
  });

  test("a name in two majors but not the one between them cannot be a range", () => {
    const catalogs = load();
    catalogs[1]!.extensions = catalogs[1]!.extensions.filter((e) => e.name !== "pgcrypto");
    expect(() => renderPostgresModule(catalogs)).toThrow(/extension pgcrypto is present in non-adjacent majors/);
  });
});
