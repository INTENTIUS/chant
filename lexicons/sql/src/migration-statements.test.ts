import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { diffStatements, renderStatements, type SchemaStatements, type StatementStep } from "./migration-statements";
import { diffStatements as fromRoot } from "./index";
import { clickhouseApply } from "./op/activities/clickhouse-apply";
import { postgresApply } from "./op/activities/postgres-apply";
import { runDiff } from "./clickhouse/plan/commands";
import { writableClickHouse, type WritableServer } from "./clickhouse/testing/writable-server";
import { writablePostgres } from "./postgres/testing/writable-server";

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

const dirs: string[] = [];
const servers: WritableServer[] = [];
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const s of servers) await s.close();
});

const build = (dialect: string, objects: Obj[], extra: Record<string, unknown> = {}) => ({
  dialect,
  ...extra,
  applyOrder: objects.map((o) => o.export),
  objects: objects.map((o) => ({ dependsOn: [], ...o })),
});

function buildFile(doc: object): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-statements-"));
  dirs.push(dir);
  const path = join(dir, "schema.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const MARKER = { stack: "shop", env: "prod" };
const config = { ownership: { stack: "shop", env: "prod" } };
const sqlOf = (doc: SchemaStatements) => doc.steps.filter((s): s is StatementStep => s.kind === "statement").map((s) => s.sql);

// ── ClickHouse ─────────────────────────────────────────────────────────

const DB: Obj = { export: "analytics", type: "ClickHouse::Database", ddl: "CREATE DATABASE analytics ENGINE = Atomic" };
const EVENTS: Obj = {
  export: "events",
  type: "ClickHouse::Table",
  dependsOn: ["analytics"],
  ddl: "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, kind String) ENGINE = MergeTree ORDER BY (ts, user_id) COMMENT 'Raw events'",
};
const EVENTS_V2: Obj = {
  ...EVENTS,
  ddl: "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, region String DEFAULT 'eu', kind LowCardinality(String)) ENGINE = MergeTree ORDER BY (ts, user_id) COMMENT 'Raw events'",
};
const SESSIONS: Obj = { export: "sessions", type: "ClickHouse::Table", dependsOn: ["analytics"], ddl: "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY id" };
const SESSIONS_RESORTED: Obj = { ...SESSIONS, ddl: "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY (ts, id)" };
const OLD: Obj = { export: "old", type: "ClickHouse::Table", dependsOn: ["analytics"], ddl: "CREATE TABLE analytics.old (a UInt8) ENGINE = MergeTree ORDER BY a" };
const BY_KIND: Obj = { export: "byKind", type: "ClickHouse::View", dependsOn: ["events"], ddl: "CREATE VIEW analytics.by_kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind" };

const CH_BEFORE = build("clickhouse", [DB, EVENTS, SESSIONS, OLD]);
const CH_AFTER = build("clickhouse", [DB, EVENTS_V2, SESSIONS_RESORTED, BY_KIND]);

describe("ClickHouse", () => {
  const doc = diffStatements(CH_BEFORE, CH_AFTER, { marker: MARKER });

  test("the statements are ordered, each with its change's rule and class", () => {
    expect(doc.dialect).toBe("clickhouse");
    expect(doc.steps.map((s) => [s.kind, s.object, s.kind === "statement" ? s.rule : s.kind === "op" ? s.op : "", s.kind === "statement" ? s.class : ""])).toEqual([
      ["statement", "events", "SQLCH201", "metadata"],
      ["statement", "events", "SQLCH210", "rewrite"],
      ["op", "sessions", "ClickHouseRebuildOp", ""],
      ["statement", "byKind", "SQLCH200", "create"],
      ["statement", "old", "SQLCH250", "drop"],
    ]);
    expect(sqlOf(doc)).toEqual([
      "ALTER TABLE `analytics`.`events` ADD COLUMN region String DEFAULT 'eu' AFTER `user_id`",
      "ALTER TABLE `analytics`.`events` MODIFY COLUMN `kind` LowCardinality(String)",
      "CREATE VIEW analytics.by_kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind COMMENT '[chant managed-by=chant stack=shop env=prod]'",
      "DROP TABLE `analytics`.`old` SYNC",
    ]);
    const rewrite = doc.steps[1] as StatementStep;
    expect(rewrite.waitsForMutation).toBe(true);
    expect((doc.steps[4] as StatementStep).destructive).toBe(true);
  });

  test("a rebuild is a step naming ClickHouseRebuildOp, never DDL", () => {
    const op = doc.steps.find((s) => s.kind === "op");
    expect(op).toMatchObject({
      kind: "op",
      object: "sessions",
      type: "ClickHouse::Table",
      name: "analytics.sessions",
      op: "ClickHouseRebuildOp",
      importPath: "@intentius/chant-lexicon-sql/clickhouse",
      options: { name: "rebuild-analytics-sessions", env: "<env>", table: "analytics.sessions", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } },
      changes: [{ rule: "SQLCH220", class: "rebuild", field: "orderBy" }],
    });
    expect(sqlOf(doc).some((s) => s.includes("sessions"))).toBe(false);
    expect(doc.refused).toBe(true);
  });

  test("a view's rebuild has no Op: it is a manual step", () => {
    const mv = { export: "mv", type: "ClickHouse::MaterializedView", ddl: "CREATE MATERIALIZED VIEW analytics.mv ENGINE = MergeTree ORDER BY kind AS SELECT kind FROM analytics.events" };
    const d = diffStatements(build("clickhouse", [DB, EVENTS, mv]), build("clickhouse", [DB, EVENTS, { ...mv, ddl: mv.ddl.replace("ORDER BY kind", "ORDER BY tuple()") }]));
    expect(d.steps).toEqual([expect.objectContaining({ kind: "manual", object: "mv", changes: [expect.objectContaining({ rule: "SQLCH243", class: "rebuild" })] })]);
    expect((d.steps[0] as { detail: string }).detail).toMatch(/drop and create this object instead/);
  });

  test("two identical builds take no steps", () => {
    expect(diffStatements(CH_BEFORE, CH_BEFORE)).toEqual({ dialect: "clickhouse", defaultDatabase: "default", steps: [], refused: false, hints: [] });
  });

  test("the applier sends the same statements for the same change", async () => {
    const s = await writableClickHouse();
    servers.push(s);
    const deps = { config, env: { CLICKHOUSE_URL: s.url }, log: () => undefined };
    await clickhouseApply({ buildPath: buildFile(CH_BEFORE), environment: "test" }, undefined, deps);
    s.writes.length = 0;
    const outcome = await clickhouseApply({ buildPath: buildFile(CH_AFTER), environment: "test", prune: true }, undefined, deps);
    expect(s.writes).toEqual(sqlOf(doc));
    // The refused rebuild is the same refusal, word for word.
    const refused = outcome.notAttempted.find((n) => n.name === "analytics.sessions");
    expect(refused?.detail).toBe((doc.steps.find((x) => x.kind === "op") as { detail: string }).detail);
  });
});

// ── Postgres ───────────────────────────────────────────────────────────

const APP: Obj = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA app" };
const USERS: Obj = {
  export: "users",
  type: "Postgres::Table",
  dependsOn: ["app"],
  ddl: "CREATE TABLE app.users (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  nick text\n);\nCOMMENT ON TABLE app.users IS 'Accounts'",
};
const USERS_V2: Obj = { ...USERS, ddl: USERS.ddl.replace("nick text", "nick text,\n  name text NOT NULL DEFAULT 'none'") };
const EMAIL_IDX: Obj = { export: "usersEmail", type: "Postgres::Index", dependsOn: ["users"], ddl: "CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email)" };
const ORDERS: Obj = { export: "orders", type: "Postgres::Table", dependsOn: ["app"], ddl: "CREATE TABLE app.orders (\n  id bigint,\n  ref text\n)" };
const ORDERS_RENAMED: Obj = { ...ORDERS, ddl: "CREATE TABLE app.orders (\n  id bigint,\n  reference text -- previously: ref\n)" };
const EMAILS: Obj = { export: "emails", type: "Postgres::View", dependsOn: ["users"], ddl: "CREATE VIEW app.emails AS SELECT email FROM app.users" };

const PG_BEFORE = build("postgres", [APP, USERS, ORDERS, EMAILS], { postgresMajor: 18 });
const PG_AFTER = build("postgres", [APP, USERS_V2, EMAIL_IDX, ORDERS_RENAMED], { postgresMajor: 18 });

describe("Postgres", () => {
  const doc = diffStatements(PG_BEFORE, PG_AFTER, { marker: MARKER, env: "prod" });

  test("the statements are ordered, each with its change's rule and class and whether it may run in a transaction", () => {
    expect(doc).toMatchObject({ dialect: "postgres", defaultSchema: "public", major: 18 });
    expect(doc.steps.filter((s): s is StatementStep => s.kind === "statement").map((s) => [s.object, s.sql, s.rule, s.class, s.transactional])).toEqual([
      ["users", "ALTER TABLE app.users ADD COLUMN name text DEFAULT 'none' NOT NULL", "SQLPG201", "metadata", true],
      ["usersEmail", "CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email)", "SQLPG240", "concurrently", false],
      ["usersEmail", "COMMENT ON INDEX app.users_email_idx IS '[chant managed-by=chant stack=shop env=prod]'", "SQLPG240", "concurrently", true],
      ["emails", "DROP VIEW app.emails", "SQLPG270", "drop", true],
    ]);
  });

  test("a column rename is a step naming PostgresMigrationOp, never DDL", () => {
    const op = doc.steps.find((s) => s.kind === "op");
    expect(op).toMatchObject({
      kind: "op",
      object: "orders",
      type: "Postgres::Table",
      name: "app.orders",
      op: "PostgresMigrationOp",
      importPath: "@intentius/chant-lexicon-sql/postgres",
      options: { name: "migrate-app-orders-reference", env: "prod", table: "app.orders", column: "reference" },
      changes: [{ rule: "SQLPG205", class: "expand", field: "columns.reference", before: "ref", after: "reference" }],
    });
    expect((op as { declaration: string }).declaration).toContain('PostgresMigrationOp({ name: "migrate-app-orders-reference", env: "prod", table: "app.orders", column: "reference" })');
    expect(sqlOf(doc).some((s) => s.includes("orders"))).toBe(false);
  });

  test("a type change across kinds is a PostgresMigrationOp step too", () => {
    const typed = { ...ORDERS, ddl: "CREATE TABLE app.orders (\n  id text,\n  ref text\n)" };
    const d = diffStatements(build("postgres", [APP, ORDERS]), build("postgres", [APP, typed]));
    expect(d.steps).toEqual([expect.objectContaining({ kind: "op", op: "PostgresMigrationOp", options: expect.objectContaining({ column: "id" }), changes: [expect.objectContaining({ rule: "SQLPG208" })] })]);
  });

  test("an expand-and-contract change no Op makes is a manual step", () => {
    const partitioned = { ...ORDERS, ddl: "CREATE TABLE app.orders (\n  id bigint NOT NULL\n)" };
    const d = diffStatements(build("postgres", [APP, { ...ORDERS, ddl: "CREATE TABLE app.orders (\n  ref text\n)" }]), build("postgres", [APP, { ...partitioned, ddl: "CREATE TABLE app.orders (\n  ref text,\n  id bigint NOT NULL\n)" }]));
    expect(d.steps).toEqual([expect.objectContaining({ kind: "manual", object: "orders", changes: [expect.objectContaining({ rule: "SQLPG203", class: "expand" })] })]);
    expect(d.refused).toBe(true);
  });

  test("the applier sends the same statements for the same change", async () => {
    const s = writablePostgres();
    const deps = {
      config,
      env: { POSTGRES_URL: "postgres://fake:5432/shop" },
      log: () => undefined,
      connect: async () => s.client,
      readLive: () => s.readLive(),
      serverNormalize: async (_client: unknown, o: unknown) => o,
    };
    await postgresApply({ buildPath: buildFile(PG_BEFORE), environment: "test" }, undefined, deps as never);
    const outcome = await postgresApply({ buildPath: buildFile(PG_AFTER), environment: "test", prune: true }, undefined, deps as never);
    const offline = doc.steps.filter((x): x is StatementStep => x.kind === "statement");
    expect(outcome.statements.map((r) => [r.sql, r.class])).toEqual(offline.map((x) => [x.sql, x.class]));
    // What may not run in a transaction block ran outside one. (A prune's DROP may, and the applier runs each alone.)
    expect(outcome.statements.filter((r, i) => !offline[i]!.transactional).map((r) => r.transaction)).toEqual([undefined]);
    expect(outcome.statements.filter((r, i) => offline[i]!.transactional && offline[i]!.class !== "drop").every((r) => r.transaction !== undefined)).toBe(true);
    const refused = outcome.notAttempted.find((n) => n.name === "app.orders");
    expect(refused?.detail).toBe((doc.steps.find((x) => x.kind === "op") as { detail: string }).detail);
  });
});

describe("the document", () => {
  test("is plain JSON: it reads back as written", () => {
    for (const doc of [diffStatements(CH_BEFORE, CH_AFTER), diffStatements(PG_BEFORE, PG_AFTER)]) {
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
      expect(JSON.stringify(doc)).not.toContain("undefined");
    }
  });

  test("takes build outputs as JSON text or parsed, and is exported from the package root", () => {
    expect(fromRoot(JSON.stringify(CH_BEFORE), JSON.stringify(CH_AFTER))).toEqual(diffStatements(CH_BEFORE, CH_AFTER));
  });

  test("takes the sql output of a multi-lexicon build", () => {
    expect(diffStatements({ sql: PG_BEFORE }, { sql: PG_AFTER })).toEqual(diffStatements(PG_BEFORE, PG_AFTER));
  });

  test("refuses builds of two dialects", () => {
    expect(() => diffStatements(CH_BEFORE, PG_AFTER)).toThrow(/different dialects/);
  });

  test("renders as a migration file's SQL, each statement after its rule and class, an Op as a comment", () => {
    const sql = renderStatements(diffStatements(PG_BEFORE, PG_AFTER, { env: "prod" }));
    expect(sql).toContain("-- usersEmail (app.users_email_idx): SQLPG240 concurrently, outside a transaction\nCREATE INDEX CONCURRENTLY users_email_idx ON app.users (email);");
    expect(sql).toContain("-- orders (app.orders): SQLPG205 made by PostgresMigrationOp, not a statement:");
    expect(sql).not.toMatch(/^ALTER TABLE app\.orders/m);
  });
});

describe("chant sql diff --statements", () => {
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      return { code: await runDiff({ verb: "diff", rawArgs: args }), out: lines.join("\n") };
    } finally {
      log.mockRestore();
    }
  };

  test("--json prints the document diffStatements returns, and exits 2 for a step that is an Op", async () => {
    const r = await capture([buildFile(CH_BEFORE), buildFile(CH_AFTER), "--statements", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual(diffStatements(CH_BEFORE, CH_AFTER));
  });

  test("without --json prints the SQL, and exits 0 when every step is a statement", async () => {
    const after = build("postgres", [APP, USERS_V2, ORDERS, EMAILS], { postgresMajor: 18 });
    const r = await capture([buildFile(PG_BEFORE), buildFile(after), "--statements"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(renderStatements(diffStatements(PG_BEFORE, after)));
    expect(r.out).toContain("ALTER TABLE app.users ADD COLUMN name text DEFAULT 'none' NOT NULL;");
  });
});
