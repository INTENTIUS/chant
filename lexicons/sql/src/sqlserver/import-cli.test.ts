/**
 * `chant import` end to end in-process, for the third Done-when box of #4398:
 * `--strict` exits non-zero while a diagnostic is open, `--report` writes the
 * SARIF, and without `--strict` the same import exits 0.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { parseArgs } from "@intentius/chant/cli/parse-args";
import { runImport } from "@intentius/chant/cli/handlers/misc";

const dir = mkdtempSync(join(tmpdir(), "sqlserver-import-cli-"));
const input = join(dir, "schema.sql");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => writeFileSync(input, "CREATE TABLE [dbo].[T] ([Id] INT NOT NULL, [Note] NVARCHAR(40) NULL, CONSTRAINT [PK_T] PRIMARY KEY CLUSTERED ([Id]));\nGO\n"));

async function run(extra: string[], name: string) {
  const out = join(dir, name);
  const args = parseArgs(["import", input, "--lexicon", "sql", "--parser-option", "from=sqlserver", "--output", out, ...extra]);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runImport({ args, plugins: [], serializers: [] });
    return { code, out, stderr: spy.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
}

describe("chant import --parser-option from=sqlserver", () => {
  test("exits 0 without --strict, writes the declarations and prints the review summary", async () => {
    const r = await run([], "plain");
    expect(r.code).toBe(0);
    expect(existsSync(join(r.out, "schema.ts"))).toBe(true);
    expect(r.stderr).toContain("Review: 3 to review");
    expect(r.stderr).toContain("SQLRV001 x1");
  });

  test("--strict exits 1 while a diagnostic is open", async () => {
    expect((await run(["--strict"], "strict")).code).toBe(1);
  });

  test("--report writes SARIF with the three diagnostics, with or without --strict", async () => {
    const report = join(dir, "review.sarif");
    const r = await run(["--report", report], "report");
    expect(r.code).toBe(0);
    const sarif = JSON.parse(readFileSync(report, "utf8")) as { runs: Array<{ results: Array<{ ruleId: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> };
    expect(sarif.runs[0]!.results.map((x) => x.ruleId).sort()).toEqual(["SQLRV001", "SQLRV002", "SQLRV003"]);
    expect(sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toContain("schema.sql");
  });

  test("a refused statement fails the import and names it", async () => {
    writeFileSync(input, "CREATE TABLE T (Id int NOT NULL);\nGO\nCREATE TRIGGER trg_t ON T AFTER INSERT AS SELECT 1\n");
    const r = await run([], "refused");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("trigger trg_t (line 3)");
  });
});
