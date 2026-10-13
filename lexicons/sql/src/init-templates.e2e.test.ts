import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { sqlPlugin } from "./plugin";
import { postSynthChecks } from "./lint/post-synth";
import { detectTemplate } from "./detect";

const cases: Array<[string | undefined, string[]]> = [
  [undefined, ["shop", "orders", "openOrders"]],
  ["events", ["analytics", "events", "hourly", "hourlyMv"]],
  ["cdc", ["mirror", "customers", "customersCurrent"]],
  ["postgres", ["app", "users", "orders", "ordersUser", "orderTotals"]],
  ["postgres-tenant", ["app", "tenants", "projects", "tasks", "tasksProject", "tasksOpen"]],
  ["postgres-events", ["analytics", "events", "eventsKind", "events202601", "events202602", "events202603"]],
];

describe("init templates", () => {
  test.each(cases)("%s builds, lints clean and passes every check", async (name, exports) => {
    const set = sqlPlugin.initTemplates!(name);
    const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
    try {
      mkdirSync(join(dir, "src"));
      for (const [file, text] of Object.entries(set.src)) writeFileSync(join(dir, "src", file), text);
      for (const [file, text] of Object.entries(set.root ?? {})) writeFileSync(join(dir, file), text);
      const result = await build(join(dir, "src"), [sqlPlugin.serializer]);
      expect(result.errors).toEqual([]);

      const out = result.outputs.get("sql") as { primary: string; files: Record<string, string> };
      expect(out).toBeTruthy();
      const doc = JSON.parse(out.primary) as { applyOrder: string[] };
      expect([...doc.applyOrder].sort()).toEqual([...exports].sort());
      // Every template's own output is recognized as a sql project.
      expect(detectTemplate(doc)).toBe(true);

      expect(runPostSynthChecks(postSynthChecks, result)).toEqual([]);

      const lint = await lintCommand({ path: join(dir, "src"), format: "stylish", fix: false });
      expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown template name falls back to the default", () => {
    expect(sqlPlugin.initTemplates!("nope")).toBe(sqlPlugin.initTemplates!());
  });

  test("the events template carries a TTL and a rollup written by a materialized view", () => {
    const src = sqlPlugin.initTemplates!("events").src;
    expect(src["events.ts"]).toContain("TTL ts + INTERVAL 90 DAY");
    expect(src["rollup.ts"]).toContain("CREATE MATERIALIZED VIEW");
  });

  test("the postgres templates declare a dialect-true document", async () => {
    for (const name of ["postgres", "postgres-tenant", "postgres-events"]) {
      const set = sqlPlugin.initTemplates!(name);
      for (const text of Object.values(set.src)) expect(text).toContain("@intentius/chant-lexicon-sql/postgres");
    }
    expect(sqlPlugin.initTemplates!("postgres-events").src["events.ts"]).toContain("PARTITION BY RANGE (occurred_at)");
    expect(sqlPlugin.initTemplates!("postgres-tenant").src["tasks.ts"]).toContain("(\${tasks.columns.tenant_id}, \${tasks.columns.project_id})");
  });

  test("the cdc template is a ReplacingMergeTree with a version column", () => {
    expect(sqlPlugin.initTemplates!("cdc").src["customers.ts"]).toContain("ReplacingMergeTree(_version, _deleted)");
  });
});

describe("detectTemplate", () => {
  const build = {
    dialect: "clickhouse",
    applyOrder: ["a", "t"],
    objects: [{ export: "a", type: "ClickHouse::Database" }, { export: "t", type: "ClickHouse::Table" }],
  };

  test("recognizes a sql build output", () => {
    expect(sqlPlugin.detectTemplate!(build)).toBe(true);
  });

  test("recognizes a Postgres build output", () => {
    expect(
      sqlPlugin.detectTemplate!({
        dialect: "postgres",
        applyOrder: ["app", "users"],
        objects: [{ export: "app", type: "Postgres::Schema" }, { export: "users", type: "Postgres::Table" }],
      }),
    ).toBe(true);
  });

  test("a document whose types are another dialect's is not claimed", () => {
    expect(sqlPlugin.detectTemplate!({ dialect: "postgres", applyOrder: ["t"], objects: [{ type: "ClickHouse::Table" }] })).toBe(false);
    expect(sqlPlugin.detectTemplate!({ dialect: "mysql", applyOrder: ["t"], objects: [{ type: "MySql::Table" }] })).toBe(false);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["no objects", { dialect: "clickhouse", applyOrder: [], objects: [] }],
    ["no dialect", { applyOrder: ["t"], objects: [{ type: "ClickHouse::Table" }] }],
    ["an untyped object", { dialect: "clickhouse", applyOrder: ["t"], objects: [{ export: "t" }] }],
    ["a dashboard", { panels: [], schemaVersion: 39 }],
    ["a prometheus rule file", { groups: [{ name: "g", rules: [{ record: "r", expr: "up" }] }] }],
  ])("does not claim %s", (_name, data) => {
    expect(sqlPlugin.detectTemplate!(data)).toBe(false);
  });
});
