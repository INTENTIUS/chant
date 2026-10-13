import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { runLint } from "@intentius/chant/lint/engine";
import { toLspDiagnostics } from "@intentius/chant/cli/lsp/diagnostics";
import { completions } from "./completions";
import { hover } from "./hover";
import { sqlPlugin } from "../plugin";

const IMPORT = 'import { table, view, index, type as pgType, extension } from "@intentius/chant-lexicon-sql/postgres";\n';

/** A source with `|` marking the cursor. */
function at(source: string, uri = "file:///schema.ts") {
  const content = IMPORT + source;
  const offset = content.indexOf("|");
  const text = content.replace("|", "");
  const before = text.slice(0, offset).split("\n");
  const line = before.length - 1;
  const linePrefix = before[line]!;
  return { uri, content: text, position: { line, character: linePrefix.length }, wordAtCursor: /\w*$/.exec(linePrefix)![0], linePrefix, word: "", lineText: "" };
}
const labels = (source: string, uri?: string) => completions(at(source, uri)).map((i) => i.label);

describe("postgres completions", () => {
  test("types where a column's type goes, aliases included", () => {
    expect(labels("export const t = table`CREATE TABLE t (id big|`;")).toContain("bigint");
    expect(labels("export const t = table`CREATE TABLE t (id int|`;")).toEqual(expect.arrayContaining(["int4", "int"]));
    expect(labels("export const t = table`CREATE TABLE t (id varc|`;")).toContain("varchar");
    expect(labels("export const t = table`CREATE TABLE t (id uu|`;")).toContain("uuid");
  });

  test("no type while a column name is typed", () => {
    expect(labels("export const t = table`CREATE TABLE t (id bigint, na|`;")).toEqual([]);
  });

  test("a type after ::", () => {
    expect(labels("export const t = table`CREATE TABLE t (a text DEFAULT 1::big|`;")).toContain("bigint");
  });

  test("index access methods after USING", () => {
    const l = labels("export const i = index`CREATE INDEX i_idx ON t USING g|`;");
    expect(l).toEqual(expect.arrayContaining(["gin", "gist"]));
    expect(l).not.toContain("heap");
  });

  test("table access methods after USING in a table", () => {
    expect(labels("export const t = table`CREATE TABLE t (a int) USING he|`;")).toContain("heap");
  });

  test("storage parameters inside WITH (, by relation kind", () => {
    const items = completions(at("export const t = table`CREATE TABLE t (a int) WITH (fillf|`;"));
    expect(items.find((i) => i.label === "fillfactor")?.insertText).toBe("fillfactor = ");
    expect(labels("export const t = table`CREATE TABLE t (a int) WITH (autosumm|`;")).toEqual([]);
    expect(labels("export const i = index`CREATE INDEX i_idx ON t USING brin (a) WITH (autosumm|`;")).toContain("autosummarize");
  });

  test("functions in expressions", () => {
    expect(labels("export const t = table`CREATE TABLE t (a timestamptz DEFAULT now|`;")).toContain("now");
    expect(labels("export const t = table`CREATE TABLE t (a int DEFAULT array_so|`;")).toContain("array_sort");
  });

  test("a configured major hides names newer than it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-pgmajor-"));
    try {
      writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["sql"], sql: { dialect: "postgres", postgresMajor: 15 } };\n');
      const uri = `file://${join(dir, "schema.ts")}`;
      expect(labels("export const t = table`CREATE TABLE t (a int DEFAULT array_so|`;", uri)).not.toContain("array_sort");
      expect(labels("export const t = table`CREATE TABLE t (a int DEFAULT any_va|`;", uri)).not.toContain("any_value");
      expect(labels("export const t = table`CREATE TABLE t (a int DEFAULT any_va|`;")).toContain("any_value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("key words", () => {
    expect(labels("export const t = table`CREATE TABLE t (a int NOT NULL DEFER|`;")).toContain("DEFERRABLE");
  });

  test("extensions", () => {
    expect(labels("export const e = extension`CREATE EXTENSION pgcr|`;")).toContain("pgcrypto");
  });

  test("ClickHouse templates are left to the ClickHouse provider", () => {
    const src = 'import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nexport const t = table`CREATE TABLE t (a UInt8) ENGINE = Repl|`;';
    const offset = src.indexOf("|");
    const text = src.replace("|", "");
    const before = text.slice(0, offset).split("\n");
    const linePrefix = before[before.length - 1]!;
    const items = completions({ uri: "file:///c.ts", content: text, position: { line: before.length - 1, character: linePrefix.length }, wordAtCursor: "Repl", linePrefix });
    expect(items.map((i) => i.label)).toContain("ReplacingMergeTree");
  });
});

describe("postgres completions inside ${}", () => {
  const decls = "export const users = table`CREATE TABLE users (id bigint PRIMARY KEY, email text NOT NULL)`;\nexport const mood = pgType`CREATE TYPE mood AS ENUM ('a')`;\n";
  test("offer declared objects with their kind", () => {
    const items = completions(at(decls + "export const o = table`CREATE TABLE o (u bigint REFERENCES ${|})`;"));
    expect(items.map((i) => i.label)).toEqual(["users", "mood"]);
    expect(items[0]!.detail).toContain("table users");
    expect(items[1]!.detail).toContain("enum type");
  });
  test("columns with their types", () => {
    expect(labels(decls + "export const o = table`CREATE TABLE o (u bigint REFERENCES ${users.|})`;")).toEqual(["columns"]);
    const items = completions(at(decls + "export const o = table`CREATE TABLE o (u bigint REFERENCES ${users} (${users.columns.|}))`;"));
    expect(items.map((i) => [i.label, i.detail])).toEqual([["id", "bigint"], ["email", "text"]]);
  });
});

const hoverAt = (source: string, uri?: string) => hover(at(source, uri) as never);

describe("postgres hover", () => {
  test("a type and its alias", () => {
    expect(hoverAt("export const t = table`CREATE TABLE t (id int4|)`;")?.contents).toContain("alias of `integer`");
  });
  test("an access method", () => {
    expect(hoverAt("export const i = index`CREATE INDEX i_idx ON t USING gi|n (a)`;")?.contents).toContain("index access method");
  });
  test("a storage parameter with its range", () => {
    expect(hoverAt("export const t = table`CREATE TABLE t (a int) WITH (fillfa|ctor = 70)`;")?.contents).toMatch(/integer, range 10\.\.100/);
  });
  test("a function with its since", () => {
    expect(hoverAt("export const t = table`CREATE TABLE t (a int DEFAULT array_so|rt(x))`;")?.contents).toContain("Postgres 18 and later");
  });
  test("a key word", () => {
    expect(hoverAt("export const t = table`CREATE TABLE t (a int NOT NU|LL)`;")?.contents).toContain("key word");
  });
  test("a reference and a column with its type", () => {
    const decls = "export const users = table`CREATE TABLE users (id bigint, email text)`;\n";
    const t = hoverAt(decls + "export const o = table`CREATE TABLE o (u bigint REFERENCES ${us|ers})`;")?.contents;
    expect(t).toContain("Postgres table `users`");
    expect(t).toContain("`email text`");
    expect(hoverAt(decls + "export const o = table`CREATE TABLE o (u bigint REFERENCES users (${users.columns.em|ail}))`;")?.contents).toContain("type `text`");
  });
});

describe("sql diagnostics for Postgres in the editor", () => {
  test("DDL that does not parse is SQLPG001 at the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-pglsp-"));
    try {
      const file = join(dir, "schema.ts");
      writeFileSync(file, 'import { table } from "@intentius/chant-lexicon-sql/postgres";\nexport const t = table`CREATE TABLE t (\n  a int,\n  b ARRAY[4]\n)`;\n');
      const { diagnostics } = await runLint([file], sqlPlugin.lintRules!());
      const [d] = toLspDiagnostics(diagnostics.filter((x) => x.ruleId === "SQLPG001"));
      expect(d).toMatchObject({ code: "SQLPG001", severity: 1, range: { start: { line: 3 } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
