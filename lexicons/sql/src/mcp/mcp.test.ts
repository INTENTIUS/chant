import { describe, expect, test } from "vitest";
import { sqlPlugin } from "../plugin";
import { sqlMcpResources, sqlMcpTools } from "./index";

const tool = (name: string) => sqlMcpTools().find((t) => t.name === name)!;

describe("sql MCP tools", () => {
  test("the plugin registers them", () => {
    expect(sqlPlugin.mcpTools?.().map((t) => t.name).sort()).toEqual(["lookup", "parse-ddl", "search", "classify-change", "sql:diff"].sort());
    expect(sqlPlugin.mcpResources?.().length).toBeGreaterThan(0);
  });

  test("lookup finds an engine and a setting", async () => {
    const e = (await tool("lookup").handler({ kind: "engine", name: "ReplacingMergeTree" })) as { matches: Array<{ syntax: string }> };
    expect(e.matches[0]!.syntax).toContain("ReplacingMergeTree");
    const s = (await tool("lookup").handler({ kind: "setting", name: "index_granularity" })) as { matches: Array<{ scope: string }> };
    expect(s.matches.map((m) => m.scope)).toContain("merge-tree");
  });

  test("lookup of an unknown name offers close ones", async () => {
    const r = (await tool("lookup").handler({ kind: "engine", name: "Replacing" })) as { matches: unknown[]; closest: string[] };
    expect(r.matches).toEqual([]);
    expect(r.closest).toContain("ReplacingMergeTree");
  });

  test("lookup refuses an unknown kind", async () => {
    await expect(tool("lookup").handler({ kind: "nope", name: "x" })).rejects.toThrow(/kind must be one of/);
  });

  test("search narrows by substring and limits", async () => {
    const r = (await tool("search").handler({ kind: "codec", query: "zstd", limit: 1 })) as { total: number; results: unknown[] };
    expect(r.total).toBeGreaterThan(0);
    expect(r.results).toHaveLength(1);
  });

  test("parse-ddl returns the entity", async () => {
    const r = (await tool("parse-ddl").handler({
      tag: "table",
      ddl: "CREATE TABLE events (user_id UUID, ts DateTime) ENGINE = MergeTree ORDER BY (user_id, ts)",
    })) as { ok: boolean; name: string; props: { columns: unknown[]; engine: { name: string } } };
    expect(r.ok).toBe(true);
    expect(r.name).toBe("events");
    expect(r.props.columns).toHaveLength(2);
    expect(r.props.engine.name).toBe("MergeTree");
  });

  test("parse-ddl reports a syntax error at its line and column", async () => {
    const r = (await tool("parse-ddl").handler({ tag: "table", ddl: "CREATE TABLE t (\n  a Strin g\n) ENGINE = Log" })) as {
      ok: boolean;
      rule: string;
      line: number;
      column: number;
    };
    expect(r).toMatchObject({ ok: false, rule: "SQLCH001", line: 2, column: 11 });
  });
});

describe("sql classify-change", () => {
  const build = (ddl: string) => JSON.stringify({ dialect: "clickhouse", objects: [{ export: "events", ddl }] });
  const base = "CREATE TABLE events (id UInt64, kind String) ENGINE = MergeTree ORDER BY id";

  test("classifies a changed engine as a rebuild with its restriction", async () => {
    const r = (await tool("classify-change").handler({
      before: build(base),
      after: build(base.replace("MergeTree", "ReplacingMergeTree")),
    })) as { summary: Record<string, number>; rebuilds: unknown[]; changes: Array<{ class: string; cite: string }> };
    expect(r.summary.rebuild).toBeGreaterThan(0);
    expect(r.rebuilds.length).toBeGreaterThan(0);
    expect(r.changes[0]!.cite).toMatch(/^https:/);
  });

  test("identical builds have no changes", async () => {
    const r = (await tool("classify-change").handler({ before: build(base), after: build(base) })) as { changes: unknown[] };
    expect(r.changes).toEqual([]);
  });
});

describe("sql MCP resources", () => {
  test("serve JSON from the catalog", async () => {
    const byUri = (uri: string) => sqlMcpResources().find((r) => r.uri === uri)!;
    expect(JSON.parse(await byUri("clickhouse-pin").handler()).version).toMatch(/^\d+\.\d+/);
    expect(JSON.parse(await byUri("clickhouse-engines").handler()).tableEngines.length).toBeGreaterThan(50);
    expect(JSON.parse(await byUri("clickhouse-types").handler()).length).toBeGreaterThan(50);
  });
});

describe("sql MCP tools for Postgres", () => {
  test("lookup finds a type, an access method and a storage parameter", async () => {
    const t = (await tool("lookup").handler({ dialect: "postgres", kind: "type", name: "int4" })) as { matches: Array<{ aliasOf: string }> };
    expect(t.matches[0]!.aliasOf).toBe("integer");
    const m = (await tool("lookup").handler({ dialect: "postgres", kind: "index-method", name: "gin" })) as { matches: Array<{ properties: string[] }> };
    expect(m.matches[0]!.properties.length).toBeGreaterThan(0);
    const s = (await tool("lookup").handler({ dialect: "postgres", kind: "storage-parameter", name: "fillfactor" })) as { matches: Array<{ targets: string[] }> };
    expect(s.matches[0]!.targets).toContain("table");
  });

  test("a function carries since, and major narrows", async () => {
    const all = (await tool("lookup").handler({ dialect: "postgres", kind: "function", name: "array_sort" })) as { matches: Array<{ since?: number }> };
    expect(all.matches[0]!.since).toBe(18);
    const at15 = (await tool("lookup").handler({ dialect: "postgres", kind: "function", name: "array_sort", major: 15 })) as { matches: unknown[]; closest: string[] };
    expect(at15.matches).toEqual([]);
    await expect(tool("lookup").handler({ dialect: "postgres", kind: "function", name: "x", major: 13 })).rejects.toThrow(/major must be one of/);
  });

  test("lookup refuses a ClickHouse kind for Postgres", async () => {
    await expect(tool("lookup").handler({ dialect: "postgres", kind: "engine", name: "x" })).rejects.toThrow(/kind must be one of/);
  });

  test("search", async () => {
    const r = (await tool("search").handler({ dialect: "postgres", kind: "keyword", query: "defer", limit: 5 })) as { total: number };
    expect(r.total).toBeGreaterThan(0);
  });

  test("parse-ddl returns the entity", async () => {
    const r = (await tool("parse-ddl").handler({ dialect: "postgres", tag: "table", ddl: "CREATE TABLE app.t (id bigint PRIMARY KEY, n text NOT NULL)" })) as { ok: boolean; entityType: string; name: string; props: { columns: unknown[] } };
    expect(r).toMatchObject({ ok: true, entityType: "Postgres::Table", name: "app.t" });
    expect(r.props.columns).toHaveLength(2);
  });

  test("parse-ddl reports SQLPG001 at line and column", async () => {
    const r = (await tool("parse-ddl").handler({ dialect: "postgres", tag: "table", ddl: "CREATE TABLE t (\n  a ARRAY[4]\n)" })) as { ok: boolean; rule: string; line: number };
    expect(r).toMatchObject({ ok: false, rule: "SQLPG001", line: 2 });
  });

  test("the postgres resources are registered under the sql namespace", async () => {
    const uris = sqlMcpResources().map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["postgres-pin", "postgres-types", "postgres-access-methods", "postgres-storage-parameters", "postgres-functions", "postgres-keywords", "postgres-settings", "clickhouse-engines"]));
    const pin = JSON.parse(await sqlMcpResources().find((r) => r.uri === "postgres-pin")!.handler()) as { pins: unknown[] };
    expect(pin.pins).toHaveLength(5);
    const fns = JSON.parse(await sqlMcpResources().find((r) => r.uri === "postgres-functions")!.handler()) as Array<{ name: string; since?: number }>;
    expect(fns.find((f) => f.name === "array_sort")?.since).toBe(18);
  });
});
