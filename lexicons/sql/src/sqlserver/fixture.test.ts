/**
 * The first two Done-when boxes of #4398, on a public sample schema: an
 * excerpt of Microsoft's WideWorldImporters (MIT, vendored in
 * `test-fixtures/sqlserver/` with its licence). The schema imports, every
 * non-mechanical decision is a SARIF diagnostic, and the output builds and
 * passes the sql lexicon's lint rules and post-synth checks.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { runLint } from "@intentius/chant/lint/engine";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { importExitCode, importSarif } from "@intentius/chant/cli/commands/import-report";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlPlugin } from "../plugin";
import { sqlTemplateGenerator } from "../import-generator";
import { postSynthChecks } from "../lint/post-synth";
import { CLICKHOUSE_DDL_FILE, sqlSerializer } from "../serializer";
import { splitStatements } from "../clickhouse/import/ir";
import { REVIEW_RULES } from "../clickhouse/review-catalog";

const fixtures = join(import.meta.dirname, "..", "..", "test-fixtures", "sqlserver");
const source = readFileSync(join(fixtures, "wwi-excerpt.sql"), "utf8");
const parse = (text: string, options: Record<string, string | boolean> = { from: "sqlserver" }) => sqlPlugin.templateParser!(options).parse(text);
const ir = parse(source);
const diagnostics = ir.diagnostics ?? [];
const ddlOf = (name: string) => (ir.resources.find((r) => (r.properties as { name: string }).name === name)!.properties as { ddl: string }).ddl;

describe("the vendored sample", () => {
  test("carries its licence, source path and commit", () => {
    const licence = readFileSync(join(fixtures, "LICENSE-sql-server-samples.txt"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Copyright (c) Microsoft Corporation");
    expect(source).toContain("Licence: MIT. Copyright (c) Microsoft Corporation");
    expect(source).toContain("samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/");
    expect(source).toMatch(/Commit:\s+[0-9a-f]{40}/);
  });
});

describe("importing it", () => {
  test("every table, view and schema becomes one object, databases first", () => {
    expect(ir.resources.map((r) => `${r.type.replace("ClickHouse::", "")} ${(r.properties as { name: string }).name}`)).toEqual([
      "Database Warehouse",
      "Database Sales",
      "Database WebApi",
      "Table StockItemTransactions",
      "Table CustomerTransactions",
      "Table Orders",
      "Table Colors",
      "Table ColdRoomTemperatures",
      "View Colors",
    ]);
    expect(ir.warnings ?? []).toEqual([]);
  });

  test("the columnstore table, the clustered-index table and the primary-key tables get the sort key the catalog picks", () => {
    expect(ddlOf("StockItemTransactions")).toContain("ORDER BY StockItemTransactionID");
    expect(ddlOf("CustomerTransactions")).toContain("ORDER BY TransactionDate");
    expect(ddlOf("Orders")).toContain("ORDER BY OrderID");
  });

  test("the generated declarations name their dependencies", () => {
    const [file] = sqlTemplateGenerator.generate(ir);
    expect(file!.content).toContain("CREATE TABLE ${warehouseDb}.StockItemTransactions");
    expect(file!.content).toContain("FROM ${warehouseColors}");
  });
});

describe("every non-mechanical decision is a diagnostic", () => {
  const at = (rule: string) => diagnostics.filter((d) => d.ruleId === rule);
  const columnsOf = (ddl: string) => [...ddl.matchAll(/^ {4}(\w+) (.+?),?$/gm)].map((m) => ({ name: m[1]!, rest: m[2]! }));

  test("each Nullable column in the DDL has a SQLRV003 diagnostic naming the table and column", () => {
    const wanted: string[] = [];
    for (const r of ir.resources) {
      const p = r.properties as { name: string; database?: string; ddl: string };
      if (r.type !== "ClickHouse::Table") continue;
      for (const c of columnsOf(p.ddl)) if (c.rest.startsWith("Nullable(")) wanted.push(`${p.database ?? ""}.${p.name}.${c.name}`.replace(/^\./, ""));
    }
    expect(wanted.length).toBeGreaterThan(10);
    expect(at("SQLRV003").map((d) => d.message.split(":")[0])).toEqual(expect.arrayContaining(wanted));
    expect(at("SQLRV003")).toHaveLength(wanted.length);
  });

  test("each table has exactly one sort key diagnostic and one engine diagnostic", () => {
    expect(at("SQLRV001").map((d) => d.entity).sort()).toEqual(["Sales.CustomerTransactions", "Sales.Orders", "Warehouse.ColdRoomTemperatures", "Warehouse.Colors", "Warehouse.StockItemTransactions"]);
    expect(at("SQLRV002")).toHaveLength(5);
  });

  test("each foreign key and unique constraint in the source is a comment in the DDL and a SQLRV005 diagnostic", () => {
    const sourceCount = [...source.matchAll(/FOREIGN KEY|\bUNIQUE NONCLUSTERED/g)].length;
    const commentCount = ir.resources.reduce((n, r) => n + [...((r.properties as { ddl: string }).ddl.matchAll(/^-- (?:FOREIGN KEY|UNIQUE)/gm))].length, 0);
    expect(sourceCount).toBeGreaterThan(15);
    expect(commentCount).toBe(sourceCount);
    expect(at("SQLRV005")).toHaveLength(sourceCount);
  });

  test("the identity column, the sequence defaults, the computed column and the period columns are SQLRV006", () => {
    const messages = at("SQLRV006").map((d) => d.message);
    expect(messages.filter((m) => m.includes("draws from a sequence"))).toHaveLength([...source.matchAll(/NEXT VALUE FOR/g)].length);
    expect(messages.some((m) => m.includes("Identity column ColdRoomTemperatureID"))).toBe(true);
    expect(messages.some((m) => m.includes("Computed column IsFinalized"))).toBe(true);
    expect(messages.filter((m) => m.includes("filled by the system"))).toHaveLength(4);
  });

  test("the sysdatetime() defaults, the view and the indexes that are not carried are diagnostics", () => {
    expect(at("SQLRV008")).toHaveLength([...source.matchAll(/DEFAULT \(sysdatetime\(\)\)/g)].length);
    expect(at("SQLRV010")).toHaveLength(1);
    const notCarried = at("SQLRV009").filter((d) => d.message.includes("is not carried") && d.message.includes("index"));
    expect(notCarried).toHaveLength([...source.matchAll(/CREATE NONCLUSTERED INDEX/g)].length + 1);
  });

  test("the diagnostics use only rules in the catalog, each with a line in the source", () => {
    for (const d of diagnostics) {
      expect(Object.keys(REVIEW_RULES)).toContain(d.ruleId);
      expect(d.line, d.message).toBeGreaterThan(0);
    }
  });

  test("the SARIF report has one result per diagnostic with its rule, level and region", () => {
    const sarif = JSON.parse(importSarif("wwi-excerpt.sql", diagnostics)) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string; level: string; message: { text: string }; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }> }> }>;
    };
    expect(sarif.version).toBe("2.1.0");
    const results = sarif.runs[0]!.results;
    expect(results).toHaveLength(diagnostics.length);
    expect(new Set(results.map((r) => r.level))).toEqual(new Set(["warning", "note"]));
    expect(results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toContain("wwi-excerpt.sql");
    expect(results.find((r) => r.ruleId === "SQLRV001")!.message.text).toContain("Evidence:");
    expect(results.every((r) => r.locations[0]!.physicalLocation.region.startLine > 0)).toBe(true);
  });
});

describe("--strict", () => {
  test("exits non-zero while a diagnostic to review is open, and zero without --strict", () => {
    expect(importExitCode(diagnostics, true)).toBe(1);
    expect(importExitCode(diagnostics, false)).toBe(0);
  });

  test("a schema whose only diagnostics are notes passes --strict", () => {
    const notes = diagnostics.filter((d) => d.severity === "info");
    expect(notes.length).toBeGreaterThan(0);
    expect(importExitCode(notes, true)).toBe(0);
  });
});

describe("refusing the sample's function", () => {
  const refused = readFileSync(join(fixtures, "wwi-refused.sql"), "utf8");

  test("the import fails and names the function and its line", () => {
    expect(() => parse(refused)).toThrow(/function Application\.DetermineCustomerAccess \(line \d+\)/);
  });

  test("with skipUndeclarable it imports the rest and warns by name", () => {
    const withTable = `${source}\nGO\n${refused}`;
    const r = parse(withTable, { from: "sqlserver", skipUndeclarable: true });
    expect(r.resources).toHaveLength(ir.resources.length);
    expect(r.diagnostics!.some((d) => d.severity === "warning" && d.message.includes("function Application.DetermineCustomerAccess"))).toBe(true);
  });
});

// The output builds and lints.
const dir = join(import.meta.dirname, "..", "..", `.sqlserver-import-tmp-${process.pid}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the output builds and lints clean", () => {
  test("the declarations build to one statement per object and pass the lexicon's lint and checks", async () => {
    const [file] = sqlTemplateGenerator.generate(ir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["sql"] };\n');
    writeFileSync(join(dir, "src", "schema.ts"), file!.content);

    const result = await build(join(dir, "src"), [sqlSerializer], undefined, { fold: true, intrinsics: sqlPlugin.intrinsics!(), lexicons: ["sql"] });
    expect(result.errors).toEqual([]);
    const statements = splitStatements((result.outputs.get("sql") as SerializerResult).files![CLICKHOUSE_DDL_FILE]!);
    expect(statements).toHaveLength(ir.resources.length);
    expect(statements.find((s) => s.includes("Warehouse.StockItemTransactions"))).toContain("ENGINE = MergeTree");

    expect(runPostSynthChecks(postSynthChecks, result)).toEqual([]);
    const lint = await runLint([join(dir, "src", "schema.ts")], sqlPlugin.lintRules!(), undefined, sqlPlugin.intrinsics!());
    expect(lint.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning")).toEqual([]);
  });
});
