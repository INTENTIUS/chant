/**
 * `--validate` for a SQL Server import (#4398), against the pinned ClickHouse
 * server: the translated sample schema is created, and a statement the server
 * refuses is reported by name.
 *
 * Needs Docker; skips cleanly without it. One throwaway container, removed
 * afterwards even on failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dockerAvailable } from "../clickhouse/container";
import { sqlPlugin } from "../plugin";
import { validateOnEmulator } from "./validate";

const enabled = await dockerAvailable();
const fixture = readFileSync(join(import.meta.dirname, "..", "..", "test-fixtures", "sqlserver", "wwi-excerpt.sql"), "utf8");
const parse = (text: string) => sqlPlugin.templateParser!({ from: "sqlserver" }).parse(text);

describe.skipIf(!enabled)("the emulator accepts the translated sample", () => {
  test("every statement of the WideWorldImporters excerpt is created", async () => {
    const diagnostics = await validateOnEmulator(parse(fixture));
    expect(diagnostics, diagnostics.map((d) => d.message).join("\n")).toEqual([]);
  }, 300_000);

  test("a view over a column the table does not have is rejected, by name", async () => {
    const diagnostics = await validateOnEmulator(parse("CREATE TABLE t (a int NOT NULL);\nGO\nCREATE VIEW v AS SELECT b FROM t"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ ruleId: "SQLRV012", severity: "error", entity: "v" });
  }, 300_000);
});
