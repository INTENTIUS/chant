import { describe, expect, test } from "vitest";
import { readMysqlCatalog } from "../spec/mysql-fetch";
import { renderMysqlModule } from "./mysql-module";

const catalog = readMysqlCatalog();
const rendered = renderMysqlModule(catalog);

describe("the MySQL module (#5449)", () => {
  test("is byte-identical across runs", () => {
    const again = renderMysqlModule(readMysqlCatalog());
    expect(again.declarations).toBe(rendered.declarations);
    expect(again.tables).toBe(rendered.tables);
  });

  test("names the version it was generated from", () => {
    expect(rendered.declarations).toContain('export const MYSQL_MAJOR = "8.0";');
    expect(rendered.declarations).toContain('export const MYSQL_VERSION = "8.0.40";');
    expect(rendered.declarations.split("\n")[0]).toContain("MySQL 8.0 catalog (8.0.40, manual)");
  });

  test("makes a union of each list, with every spelling of a type", () => {
    const d = rendered.declarations;
    expect(d).toMatch(/export type MysqlTypeName = "BIGINT" \| "BINARY"/);
    expect(d).toMatch(/export type MysqlTypeSpelling = [^\n]*"INTEGER"[^\n]*"INT4"/s);
    expect(d).toContain('export type MysqlEngine = "ARCHIVE" | "BLACKHOLE" | "CSV" | "FEDERATED" | "InnoDB"');
    expect(d).toContain('"utf8mb4"');
    expect(d).toContain('export type MysqlIndexType = "BTREE" | "FULLTEXT" | "HASH" | "SPATIAL";');
    expect(d).toContain('"NO ACTION"');
  });

  test("writes the tables lint and the editor read", () => {
    const t = rendered.tables;
    expect(t).toContain('VARCHAR: {"family":"character","aliases":["CHARACTER VARYING","VARCHARACTER"],"parameters":{"kind":"length","required":true,"max":65535}');
    expect(t).toContain('INTEGER: "INT",');
    expect(t).toContain('"DOUBLE PRECISION": "DOUBLE",');
    expect(t).toContain('InnoDB: {"declarable":true,"default":true,"transactional":true},');
    expect(t).toContain('utf8mb4: {"defaultCollation":"utf8mb4_0900_ai_ci","maxLength":4},');
    expect(t).toContain('export const RESERVED_WORDS: ReadonlySet<MysqlReservedWord> = new Set<MysqlReservedWord>([');
  });

  test("refuses a catalog that is not whole", () => {
    expect(() => renderMysqlModule({ ...catalog, indexTypes: ["HASH", "BTREE"] })).toThrow(/not whole/);
  });
});
