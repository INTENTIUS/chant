import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { classifyDisruption } from "./disruption";
import { inDeclaredVocabulary } from "./deep";
import { canonicalObject } from "./normalize";
import { runDiff } from "./commands";
import { table } from "../entities";

describe("classifyDisruption", () => {
  const q = (paths: string[]) => ({ name: "t", type: "ClickHouse::Table", deltas: paths.map((path) => ({ path, oldValue: 1, newValue: 2 })) });
  const run = (paths: string[]) => classifyDisruption({ environment: "e", changes: [q(paths)] }).t!;

  test("metadata is in-place, a rewrite rolling, a rebuild replace", () => {
    expect(run(["comment", "indexes[0].name"]).disruption).toBe("in-place");
    expect(run(["ttl"]).disruption).toBe("rolling");
    expect(run(["ttl", "partitionBy"])).toMatchObject({ disruption: "replace", because: ["partitionBy"] });
    expect(run(["settings.index_granularity"]).disruption).toBe("replace");
  });

  test("a column type or sorting-key change is unknown without the whole definition", () => {
    expect(run(["columns[2].type"]).disruption).toBe("unknown");
    expect(run(["orderBy"]).disruption).toBe("unknown");
  });

  test("another lexicon's entry is left alone", () => {
    expect(classifyDisruption({ environment: "e", changes: [{ name: "x", type: "K8s::Core::Pod", deltas: [] }] })).toEqual({});
  });
});

describe("the deep read in the declaration's vocabulary", () => {
  const declared = table`CREATE TABLE t (ts DateTime CODEC(Delta, ZSTD), n UInt8) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 1 DAY`;
  const shown = "CREATE TABLE default.t\n(\n    `ts` DateTime CODEC(Delta(4), ZSTD(1)),\n    `n` UInt8\n)\nENGINE = MergeTree\nORDER BY ts\nTTL ts + toIntervalDay(1)\nSETTINGS index_granularity = 8192";
  const strings = Object.assign([shown], { raw: [shown] }) as unknown as TemplateStringsArray;
  const live = table(strings).props as unknown as Record<string, unknown>;
  const props = declared.props as unknown as Record<string, unknown>;

  test("a field the server only reformatted reads as declared", () => {
    const out = inDeclaredVocabulary(props, live, canonicalObject(String(props.ddl)), canonicalObject(shown));
    expect(out.ttl).toBe(props.ttl);
    expect(out.columns).toEqual(props.columns);
    expect(out.settings).toBeUndefined();
  });

  test("a field that really differs keeps the server's value", () => {
    const changed = shown.replace("toIntervalDay(1)", "toIntervalDay(2)");
    const s2 = Object.assign([changed], { raw: [changed] }) as unknown as TemplateStringsArray;
    const out = inDeclaredVocabulary(props, table(s2).props as unknown as Record<string, unknown>, canonicalObject(String(props.ddl)), canonicalObject(changed));
    expect(out.ttl).toBe("ts + toIntervalDay(2)");
  });
});

describe("chant sql diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-diff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, ddl: string) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify({ dialect: "clickhouse", applyOrder: ["events"], objects: [{ export: "events", ddl }] }));
    return file;
  };

  test("exits 2 on a rebuild, 0 otherwise, and prints the classification", async () => {
    const base = write("base.json", "CREATE TABLE events (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY id");
    const head = write("head.json", "CREATE TABLE events (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY (ts, id)");
    const add = write("add.json", "CREATE TABLE events (id UInt64, ts DateTime, x String) ENGINE = MergeTree ORDER BY id");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runDiff({ verb: "diff", rawArgs: [base, head] })).toBe(2);
      expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/SQLCH220/);
      expect(await runDiff({ verb: "diff", rawArgs: [base, add, "--json"] })).toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).changes[0].rule).toBe("SQLCH201");
    } finally {
      log.mockRestore();
    }
  });
});
