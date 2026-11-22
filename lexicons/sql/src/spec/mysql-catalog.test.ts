/**
 * The MySQL catalog snapshot and its pin (#5449): the snapshot is whole, it
 * agrees with the pin, and a server's version is classified into the lines the
 * dialect supports.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mysqlCatalogProblems, parseMysqlCatalog, type MysqlCatalog } from "./mysql-catalog";
import { readMysqlCatalog, mysqlSnapshotPath } from "./mysql-fetch";
import { classifyMysqlVersion, MYSQL_MAJORS, MYSQL_PINS, mysqlPin } from "./mysql-pin";

const catalog = (): MysqlCatalog => JSON.parse(readFileSync(mysqlSnapshotPath("8.0"), "utf-8")) as MysqlCatalog;

describe("the MySQL 8.0 snapshot", () => {
  test("is whole: sorted, no name twice, one default engine, no spelling claimed by two types", () => {
    expect(mysqlCatalogProblems(catalog())).toEqual([]);
  });

  test("agrees with the pin", () => {
    const c = readMysqlCatalog();
    expect(c.major).toBe(MYSQL_PINS[0]!.major);
    expect(c.version).toBe(MYSQL_PINS[0]!.version);
  });

  test("names the types a MySQL 8.0 table is written with, and where their spellings lead", () => {
    const c = catalog();
    const byName = new Map(c.types.map((t) => [t.name, t]));
    for (const name of ["BIGINT", "INT", "VARCHAR", "TEXT", "DATETIME", "TIMESTAMP", "DECIMAL", "JSON", "ENUM", "SET", "BLOB", "POINT"]) expect(byName.has(name), name).toBe(true);
    expect(byName.get("INT")!.aliases).toContain("INTEGER");
    expect(byName.get("DECIMAL")!.aliases).toEqual(["DEC", "FIXED", "NUMERIC"]);
    expect(byName.get("VARCHAR")!.parameters).toEqual({ kind: "length", required: true, max: 65535 });
    expect(byName.get("DATETIME")!.parameters).toEqual({ kind: "fsp", max: 6 });
    expect(byName.get("BOOLEAN")!.aliases).toEqual(["BOOL"]);
  });

  test("InnoDB is the one default engine, and PERFORMANCE_SCHEMA cannot hold a table", () => {
    const engines = new Map(catalog().engines.map((e) => [e.name, e]));
    expect(catalog().engines.filter((e) => e.default).map((e) => e.name)).toEqual(["InnoDB"]);
    expect(engines.get("InnoDB")).toMatchObject({ declarable: true, transactional: true });
    expect(engines.get("PERFORMANCE_SCHEMA")!.declarable).toBe(false);
  });

  test("utf8mb4 is the 4-byte set whose default collation is utf8mb4_0900_ai_ci", () => {
    expect(catalog().charsets.find((c) => c.name === "utf8mb4")).toEqual({ name: "utf8mb4", defaultCollation: "utf8mb4_0900_ai_ci", maxLength: 4 });
  });

  test("lists the reserved words that need backticks", () => {
    const words = new Set(catalog().keywords.filter((k) => k.reserved).map((k) => k.word));
    for (const w of ["SELECT", "TABLE", "KEY", "ORDER", "GROUP", "INDEX", "RANK", "WINDOW", "LATERAL", "CUME_DIST"]) expect(words.has(w), w).toBe(true);
    expect(words.has("NAME")).toBe(false);
  });
});

describe("parseMysqlCatalog", () => {
  test("refuses a catalog with a section missing, or an unsorted or doubled list", () => {
    const c = catalog();
    expect(() => parseMysqlCatalog(JSON.stringify({ ...c, types: undefined }))).toThrow(/has no types/);
    expect(() => parseMysqlCatalog(JSON.stringify({ ...c, indexTypes: ["HASH", "BTREE"] }))).toThrow(/indexTypes is not sorted/);
    expect(() => parseMysqlCatalog(JSON.stringify({ ...c, rowFormats: ["DYNAMIC", "DYNAMIC"] }))).toThrow(/rowFormats has a name twice/);
    const dup = { ...c, types: [...c.types, { ...c.types[0]!, name: "ZZ", aliases: ["INTEGER"] }] };
    expect(mysqlCatalogProblems(dup)).toEqual([expect.stringContaining("INTEGER is spelled by both INT and ZZ")]);
  });
});

describe("the pin", () => {
  test("MySQL 8.0 is the one supported line, and Aurora MySQL 3 reads as it", () => {
    expect(MYSQL_MAJORS).toEqual(["8.0"]);
    expect(mysqlPin("8.0").aurora).toEqual(["3"]);
    expect(() => mysqlPin("5.7")).toThrow(/not a supported major/);
  });

  test("a server's version is classified, and MariaDB is not MySQL", () => {
    expect(classifyMysqlVersion("8.0.40")).toEqual({ flavor: "mysql", major: "8.0", version: "8.0.40" });
    expect(classifyMysqlVersion("8.0.40-0ubuntu0.22.04.1")).toMatchObject({ flavor: "mysql", major: "8.0" });
    expect(classifyMysqlVersion("8.0.mysql_aurora.3.07.1")).toEqual({ flavor: "aurora", major: "8.0", version: "8.0.mysql_aurora.3.07.1" });
    expect(classifyMysqlVersion("5.7.mysql_aurora.2.11.4")).toEqual({ flavor: "unsupported", version: "5.7.mysql_aurora.2.11.4" });
    expect(classifyMysqlVersion("10.11.6-MariaDB-1:10.11.6+maria~ubu2204")).toEqual({ flavor: "mariadb", version: "10.11.6-MariaDB-1:10.11.6+maria~ubu2204" });
    expect(classifyMysqlVersion("5.7.44")).toEqual({ flavor: "unsupported", version: "5.7.44" });
    expect(classifyMysqlVersion("9.1.0")).toEqual({ flavor: "unsupported", version: "9.1.0" });
  });
});
