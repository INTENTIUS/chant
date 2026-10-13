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
import type { Topology } from "./clickhouse/topology";

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

  test("a user the environment creates gets its declared clauses with ALTER USER, its password left alone (#3717)", () => {
    const reader: Obj = { export: "reader", type: "ClickHouse::Role", ddl: "CREATE ROLE reader" };
    const app: Obj = {
      export: "app",
      type: "ClickHouse::User",
      dependsOn: ["reader", "analytics"],
      ddl: "CREATE USER app HOST LOCAL DEFAULT ROLE reader DEFAULT DATABASE analytics SETTINGS max_memory_usage = 1000000000",
    };
    const readerToApp: Obj = { export: "readerToApp", type: "ClickHouse::Grant", dependsOn: ["reader", "app"], ddl: "GRANT reader TO app" };
    const d = diffStatements(build("clickhouse", [DB]), build("clickhouse", [DB, reader, app, readerToApp]));
    const sql = sqlOf(d);
    expect(sql).toEqual([
      "CREATE ROLE reader",
      "ALTER USER `app` HOST LOCAL",
      "ALTER USER `app` DEFAULT DATABASE analytics",
      "ALTER USER `app` SETTINGS max_memory_usage = 1000000000",
      "GRANT `reader` TO `app`",
      // A default role must be held first.
      "ALTER USER `app` DEFAULT ROLE reader",
    ]);
    expect(sql.join("\n")).not.toMatch(/CREATE USER|IDENTIFIED/);
    expect(d.steps.filter((s) => s.object === "app").map((s) => (s as StatementStep).rule)).toEqual(["SQLCH271", "SQLCH271", "SQLCH271"]);

    // Without grants to it, the default role is set with the rest.
    const alone = sqlOf(diffStatements(build("clickhouse", [DB, reader]), build("clickhouse", [DB, reader, app])));
    expect(alone).toEqual([
      "ALTER USER `app` HOST LOCAL",
      "ALTER USER `app` DEFAULT DATABASE analytics",
      "ALTER USER `app` SETTINGS max_memory_usage = 1000000000",
      "ALTER USER `app` DEFAULT ROLE reader",
    ]);
  });

  test("two identical builds take no steps", () => {
    expect(diffStatements(CH_BEFORE, CH_BEFORE)).toEqual({ dialect: "clickhouse", defaultDatabase: "default", topology: "single", steps: [], refused: false, hints: [] });
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

  test("a unique index on a table that exists carries its duplicate count, one on a new table none (#3686)", () => {
    const unique: Obj = { export: "usersNick", type: "Postgres::Index", dependsOn: ["users"], ddl: "CREATE UNIQUE INDEX CONCURRENTLY users_nick_key ON app.users (nick) WHERE nick <> ''" };
    const d = diffStatements(build("postgres", [APP, USERS]), build("postgres", [APP, USERS, unique]));
    const built = d.steps.find((s): s is StatementStep => s.kind === "statement" && s.sql.startsWith("CREATE UNIQUE INDEX"));
    expect(built?.precheck).toEqual({
      sql: "SELECT (SELECT count(*) FROM (SELECT 1 FROM app.users WHERE nick IS NOT NULL AND (nick <> '') GROUP BY nick HAVING count(*) > 1) AS duplicates) AS n",
      detail: "values of (nick) held by more than one row, which a unique index fails on",
    });
    expect(renderStatements(d)).toContain(`-- pre-check, must return 0 (values of (nick) held by more than one row, which a unique index fails on): ${built!.precheck!.sql}`);
    const fresh = diffStatements(build("postgres", [APP]), build("postgres", [APP, USERS, unique]));
    expect(fresh.steps.some((s) => s.kind === "statement" && s.precheck !== undefined)).toBe(false);
  });

  test("SET NOT NULL renders as its four statements, the first with the NULL count (#3686)", () => {
    const d = diffStatements(build("postgres", [APP, USERS]), build("postgres", [APP, { ...USERS, ddl: USERS.ddl.replace("nick text", "nick text NOT NULL") }]));
    const st = d.steps.filter((s): s is StatementStep => s.kind === "statement");
    expect(st.map((s) => [s.sql, s.rule, s.class])).toEqual([
      ["ALTER TABLE app.users ADD CONSTRAINT nick__chant_nn CHECK (nick IS NOT NULL) NOT VALID", "SQLPG217", "metadata"],
      ["ALTER TABLE app.users VALIDATE CONSTRAINT nick__chant_nn", "SQLPG220", "validate"],
      ["ALTER TABLE app.users ALTER COLUMN nick SET NOT NULL", "SQLPG210", "metadata"],
      ["ALTER TABLE app.users DROP CONSTRAINT nick__chant_nn", "SQLPG223", "metadata"],
    ]);
    expect(st[0]!.precheck?.sql).toBe("SELECT count(*) AS n FROM app.users WHERE nick IS NULL");
  });

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

// ── ClickHouse topologies (#3645) ──────────────────────────────────────

describe("ClickHouse statements per topology", () => {
  const EMPTY = build("clickhouse", []);
  const MV: Obj = {
    export: "counts",
    type: "ClickHouse::MaterializedView",
    dependsOn: ["events"],
    ddl: "CREATE MATERIALIZED VIEW analytics.counts ENGINE = SummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind",
  };
  const FIRST = build("clickhouse", [DB, EVENTS, SESSIONS, OLD, MV]);
  const TOPOLOGIES: Array<[string, Topology]> = [
    ["single", { kind: "single" }],
    ["cluster:main", { kind: "cluster", cluster: "main" }],
    ["replicated", { kind: "replicated" }],
    ["cloud", { kind: "cloud" }],
  ];
  const created = (t: Topology) => sqlOf(diffStatements(EMPTY, FIRST, { marker: MARKER, topology: t })).map((s) => s.replace(/ COMMENT '[^']*\[chant[^']*'$/, ""));
  const R = "'/clickhouse/tables/{uuid}/{shard}', '{replica}'";

  test("single is the default, and the declarations as written", () => {
    expect(diffStatements(EMPTY, FIRST, { marker: MARKER })).toEqual(diffStatements(EMPTY, FIRST, { marker: MARKER, topology: { kind: "single" } }));
    expect(created({ kind: "single" })).toEqual([
      "CREATE DATABASE analytics ENGINE = Atomic",
      "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, kind String) ENGINE = MergeTree ORDER BY (ts, user_id)",
      "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY id",
      "CREATE TABLE analytics.old (a UInt8) ENGINE = MergeTree ORDER BY a",
      "CREATE MATERIALIZED VIEW analytics.counts ENGINE = SummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind",
    ]);
    expect(diffStatements(EMPTY, FIRST).topology).toBe("single");
  });

  test("a cluster creates everything ON CLUSTER, with Replicated engines and their Keeper path", () => {
    expect(created({ kind: "cluster", cluster: "main" })).toEqual([
      "CREATE DATABASE analytics ON CLUSTER `main` ENGINE = Atomic",
      `CREATE TABLE analytics.events ON CLUSTER \`main\` (ts DateTime, user_id UInt64, kind String) ENGINE = ReplicatedMergeTree(${R}) ORDER BY (ts, user_id)`,
      `CREATE TABLE analytics.sessions ON CLUSTER \`main\` (id UInt64, ts DateTime) ENGINE = ReplicatedMergeTree(${R}) ORDER BY id`,
      `CREATE TABLE analytics.old ON CLUSTER \`main\` (a UInt8) ENGINE = ReplicatedMergeTree(${R}) ORDER BY a`,
      `CREATE MATERIALIZED VIEW analytics.counts ON CLUSTER \`main\` ENGINE = ReplicatedSummingMergeTree(${R}) ORDER BY kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind`,
    ]);
    expect(diffStatements(EMPTY, FIRST, { topology: { kind: "cluster", cluster: "main" } }).topology).toBe("cluster:main");
  });

  test("a Replicated database: the database Replicated, its tables Replicated with no path, no ON CLUSTER", () => {
    expect(created({ kind: "replicated" })).toEqual([
      "CREATE DATABASE analytics ENGINE = Replicated('/clickhouse/databases/analytics', '{shard}', '{replica}')",
      "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, kind String) ENGINE = ReplicatedMergeTree ORDER BY (ts, user_id)",
      "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = ReplicatedMergeTree ORDER BY id",
      "CREATE TABLE analytics.old (a UInt8) ENGINE = ReplicatedMergeTree ORDER BY a",
      "CREATE MATERIALIZED VIEW analytics.counts ENGINE = ReplicatedSummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind",
    ]);
  });

  test("Cloud takes the plain family", () => {
    expect(created({ kind: "cloud" })).toEqual(created({ kind: "single" }));
  });

  test("a source written for a cluster renders back to plain DDL for a single node", () => {
    const clustered = build("clickhouse", [
      { ...EVENTS, ddl: `CREATE TABLE analytics.events ON CLUSTER prod (ts DateTime, user_id UInt64, kind String) ENGINE = ReplicatedMergeTree('/t/{shard}/events', '{replica}') ORDER BY (ts, user_id)` },
    ]);
    expect(sqlOf(diffStatements(EMPTY, clustered))[0]).toMatch(/^CREATE TABLE analytics\.events \(ts DateTime, user_id UInt64, kind String\) ENGINE = MergeTree\(\) ORDER BY \(ts, user_id\) COMMENT /);
  });

  test("the changes between two builds: ON CLUSTER on every ALTER and DROP on a cluster, as written elsewhere", () => {
    const base = sqlOf(diffStatements(CH_BEFORE, CH_AFTER, { marker: MARKER }));
    for (const t of [{ kind: "replicated" }, { kind: "cloud" }] as Topology[]) expect(sqlOf(diffStatements(CH_BEFORE, CH_AFTER, { marker: MARKER, topology: t }))).toEqual(base);
    expect(sqlOf(diffStatements(CH_BEFORE, CH_AFTER, { marker: MARKER, topology: { kind: "cluster", cluster: "main" } }))).toEqual([
      "ALTER TABLE `analytics`.`events` ON CLUSTER `main` ADD COLUMN region String DEFAULT 'eu' AFTER `user_id`",
      "ALTER TABLE `analytics`.`events` ON CLUSTER `main` MODIFY COLUMN `kind` LowCardinality(String)",
      "CREATE VIEW analytics.by_kind ON CLUSTER `main` AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind COMMENT '[chant managed-by=chant stack=shop env=prod]'",
      "DROP TABLE `analytics`.`old` ON CLUSTER `main` SYNC",
    ]);
  });

  test("an engine the topology changes is no change: a cluster's Replicated engine compares equal to the declared MergeTree", () => {
    for (const [, t] of TOPOLOGIES) expect(diffStatements(FIRST, FIRST, { topology: t }).steps).toEqual([]);
  });

  test.each(TOPOLOGIES)("the applier sends the same statements as the offline renderer for %s", async (label, t) => {
    const s = await writableClickHouse();
    servers.push(s);
    const deps = { config, env: { CLICKHOUSE_URL: s.url, CLICKHOUSE_TOPOLOGY: label }, log: () => undefined };
    await clickhouseApply({ buildPath: buildFile(FIRST), environment: "test" }, undefined, deps);
    expect(s.writes).toEqual(sqlOf(diffStatements(EMPTY, FIRST, { marker: MARKER, topology: t })));
    // Applied again: nothing to send, the engines it created compare equal to the declarations rendered for it.
    s.writes.length = 0;
    await clickhouseApply({ buildPath: buildFile(FIRST), environment: "test" }, undefined, deps);
    expect(s.writes).toEqual([]);
    const after = build("clickhouse", [DB, EVENTS_V2, SESSIONS_RESORTED, BY_KIND, MV]);
    await clickhouseApply({ buildPath: buildFile(after), environment: "test", prune: true }, undefined, deps);
    expect(s.writes).toEqual(sqlOf(diffStatements(FIRST, after, { marker: MARKER, topology: t })));
  });

  test("chant sql diff --statements --topology renders for that topology", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      expect(await runDiff({ verb: "diff", rawArgs: [buildFile(EMPTY), buildFile(FIRST), "--statements", "--json", "--topology", "cluster:main"] })).toBe(0);
      expect(await runDiff({ verb: "diff", rawArgs: [buildFile(EMPTY), buildFile(FIRST), "--statements", "--json", "--topology=replicated"] })).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(lines[0]!)).toEqual(diffStatements(EMPTY, FIRST, { topology: { kind: "cluster", cluster: "main" } }));
    expect(JSON.parse(lines[1]!)).toEqual(diffStatements(EMPTY, FIRST, { topology: { kind: "replicated" } }));
  });

  test("chant sql diff refuses a topology it does not know", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runDiff({ verb: "diff", rawArgs: [buildFile(EMPTY), buildFile(FIRST), "--statements", "--topology", "sharded"] })).toBe(1);
      expect(err.mock.calls[0]![0]).toMatch(/--topology: unknown topology "sharded"/);
    } finally {
      err.mockRestore();
    }
  });
});
