import { describe, expect, test } from "vitest";
import { ClickHouseQueryError } from "../clickhouse/http";
import { sqlPlugin } from "../plugin";
import { statementsOf, validateStatements } from "./validate";

const ir = sqlPlugin.templateParser!({ from: "sqlserver" }).parse(`
CREATE VIEW WebApi.V AS SELECT x FROM Sales.T;
GO
CREATE TABLE Sales.T (x int NOT NULL);
`);

describe("validateStatements", () => {
  test("runs databases, then tables, then views, whatever order the file had", () => {
    expect(statementsOf(ir).map((s) => `${s.type.replace("ClickHouse::", "")} ${s.name}`)).toEqual(["Database WebApi", "Database Sales", "Table Sales.T", "View WebApi.V"]);
  });

  test("a statement the server accepts raises nothing", async () => {
    const seen: string[] = [];
    const out = await validateStatements(statementsOf(ir), async (sql) => void seen.push(sql));
    expect(out).toEqual([]);
    expect(seen).toHaveLength(4);
    expect(seen[2]).toContain("CREATE TABLE Sales.T");
  });

  test("a refusal is an error diagnostic with the server's first line, and the run goes on", async () => {
    const out = await validateStatements(statementsOf(ir), async (sql) => {
      if (sql.includes("CREATE VIEW")) throw new ClickHouseQueryError(400, "Code: 47. DB::Exception: Unknown identifier x\nstack trace", sql);
      if (sql.includes("CREATE TABLE")) throw new Error("connection reset");
    });
    expect(out).toEqual([
      { ruleId: "SQLRV012", severity: "error", entity: "Sales.T", message: "Sales.T: the emulator rejected the statement. connection reset" },
      { ruleId: "SQLRV012", severity: "error", entity: "WebApi.V", message: "WebApi.V: the emulator rejected the statement. Code: 47. DB::Exception: Unknown identifier x" },
    ]);
  });

  test("a refusal fails the run even without --strict", async () => {
    const { importExitCode } = await import("@intentius/chant/cli/commands/import-report");
    const out = await validateStatements(statementsOf(ir), async () => {
      throw new Error("no");
    });
    expect(importExitCode(out, false)).toBe(1);
  });
});

describe("validateImport", () => {
  test("is the sql plugin's hook for --validate", () => {
    expect(typeof sqlPlugin.validateImport).toBe("function");
  });
});
