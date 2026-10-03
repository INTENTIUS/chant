import { describe, expect, test } from "vitest";
import { hover } from "./hover";

const ctx = (word: string) => ({
  uri: "file:///schema.ts",
  content: word,
  position: { line: 0, character: 0 },
  word,
  lineText: word,
});

describe("sql hover", () => {
  test("says nothing about a word that is not an entity class", () => {
    expect(hover(ctx("NotAnEntity"))).toBeUndefined();
  });

  test("says nothing about an empty word", () => {
    expect(hover(ctx(""))).toBeUndefined();
  });
});

const IMPORT = 'import { table, view, database } from "@intentius/chant-lexicon-sql/clickhouse";\n';

/** A source with `|` marking the cursor. */
function over(source: string) {
  const content = IMPORT + source;
  const offset = content.indexOf("|");
  const text = content.replace("|", "");
  const before = text.slice(0, offset).split("\n");
  const line = before.length - 1;
  const lineText = text.split("\n")[line]!;
  const character = before[line]!.length;
  const word = (/\w*$/.exec(lineText.slice(0, character))![0] + /^\w*/.exec(lineText.slice(character))![0]);
  return { uri: "file:///schema.ts", content: text, position: { line, character }, word, lineText };
}
const hoverText = (source: string) => hover(over(source))?.contents;

describe("sql hover inside a template", () => {
  test("an engine shows its usage line and summary", () => {
    const h = hoverText("export const t = table`CREATE TABLE t (a UInt8) ENGINE = Replacing|MergeTree ORDER BY a`;");
    expect(h).toContain("ReplacingMergeTree");
    expect(h).toContain("ENGINE = ReplacingMergeTree(");
  });

  test("a type family", () => {
    expect(hoverText("export const t = table`CREATE TABLE t (id UU|ID)`;")).toContain("type family");
  });

  test("an alias type names what it stands for", () => {
    expect(hoverText("export const t = table`CREATE TABLE t (id BIG|INT)`;")).toContain("Int64");
  });

  test("a MergeTree setting shows type, default and description", () => {
    const h = hoverText("export const t = table`CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_gran|ularity = 8192`;");
    expect(h).toContain("MergeTree setting");
    expect(h).toContain("UInt64");
  });

  test("a function followed by a call", () => {
    expect(hoverText("export const v = view`CREATE VIEW v AS SELECT cou|nt() FROM t`;")).toContain("aggregate function");
  });

  test("a codec", () => {
    expect(hoverText("export const t = table`CREATE TABLE t (a UInt8 CODEC(ZS|TD(3)))`;")).toContain("codec");
  });

  test("a column name is not a catalog word", () => {
    expect(hoverText("export const t = table`CREATE TABLE t (us|er_id UInt8)`;")).toBeUndefined();
  });
});

describe("sql hover on a ${ref}", () => {
  const events = 'export const events = table`CREATE TABLE events (user_id UUID, kind String) ENGINE = Log`;\n';

  test("a table shows its name, engine and columns", () => {
    const h = hoverText(events + "export const v = view`CREATE VIEW v AS SELECT 1 FROM ${ev|ents}`;");
    expect(h).toContain("table `events`");
    expect(h).toContain("user_id UUID");
    expect(h).toContain("Log");
  });

  test("a column shows its type", () => {
    const h = hoverText(events + "export const v = view`CREATE VIEW v AS SELECT ${events.columns.user|_id} FROM events`;");
    expect(h).toContain("type `UUID`");
  });

  test("a column that does not exist says so", () => {
    expect(hoverText(events + "export const v = view`CREATE VIEW v AS SELECT ${events.columns.nope|}`;")).toContain("no column");
  });
});
