/**
 * The sql composites (ClickHouse #3212, Postgres #3286): their props and defaults, the entity types they
 * build, the references between members, the lexicon's own post-synth checks
 * over what they build, and the provenance each field keeps (#3212).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandComposite, type CompositeInstance } from "@intentius/chant/composite";
import { build } from "@intentius/chant/build";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { AuditLogTable, CdcMirror, EventsTable, JoinTable, RefreshedView, ReplacingTable, RollupView, ShardedTable, SoftDeleteTable, TenantTable } from "./index";
import { schema, POSTGRES_ENTITY_TYPES, type PostgresTable } from "../postgres/entities";
import { table, CLICKHOUSE_ENTITY_TYPES, SqlTemplateError, type ClickHouseObject } from "../clickhouse/entities";
import { sqlSerializer } from "../serializer";
import { postSynthChecks } from "../lint/post-synth";
import { sqlPlugin } from "../plugin";
import { getProvenance, originOfPath } from "@intentius/chant/provenance";
import { resolveDriftedField } from "@intentius/chant/fold-provenance";

const flat = (ddl: string) => ddl.replace(/\s+/g, " ").trim();
const ddlOf = (entity: unknown) => flat((entity as ClickHouseObject & { props: { ddl: string } }).props.ddl);
const propsOf = (entity: unknown) => (entity as { props: Record<string, unknown> }).props;

const events = () =>
  EventsTable({ name: "events", columns: "user_id UUID, kind LowCardinality(String)", orderBy: "(kind, user_id, ts)" });

describe("ReplacingTable", () => {
  test("defaults: a UInt64 `version` column, the engine reading it, no partition", () => {
    const { table: t } = ReplacingTable({ name: "users", columns: "id UInt64, email String", orderBy: "id" });
    expect(t.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.table);
    expect(ddlOf(t)).toBe(
      "CREATE TABLE users ( id UInt64, email String, version UInt64 ) ENGINE = ReplacingMergeTree(version) ORDER BY id",
    );
    expect(t.props.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "UInt64"],
      ["email", "String"],
      ["version", "UInt64"],
    ]);
    expect(t.props.engine).toEqual({ name: "ReplacingMergeTree", args: ["version"] });
    expect(t.props.partitionBy).toBeUndefined();
    expect(Object.keys(t.columns)).toEqual(["id", "email", "version"]);
  });

  test("every optional prop reaches its field", () => {
    const { table: t } = ReplacingTable({
      name: "app.users",
      columns: "id UInt64, email String, updated DateTime",
      orderBy: "id",
      version: "updated_at",
      versionType: "DateTime64(3)",
      partitionBy: "toYYYYMM(updated)",
    });
    expect(t.props.database).toBe("app");
    expect(t.props.name).toBe("users");
    expect(t.props.columns.at(-1)).toEqual({ name: "updated_at", type: "DateTime64(3)" });
    expect(t.props.engine).toEqual({ name: "ReplacingMergeTree", args: ["updated_at"] });
    expect(t.props.partitionBy).toBe("toYYYYMM(updated)");
  });
});

describe("EventsTable", () => {
  test("defaults: a DateTime `ts`, monthly partitions, 90 days of TTL, whole parts dropped", () => {
    const { table: t } = events();
    expect(t.props.columns.at(-1)).toEqual({ name: "ts", type: "DateTime" });
    expect(t.props.engine).toEqual({ name: "MergeTree" });
    expect(t.props.partitionBy).toBe("toYYYYMM(ts)");
    expect(t.props.orderBy).toBe("(kind, user_id, ts)");
    expect(t.props.ttl).toBe("ts + INTERVAL 90 DAY");
    expect(t.props.settings).toEqual({ ttl_only_drop_parts: "1" });
  });

  test("the timestamp, its type, the TTL and the partition key are parameters", () => {
    const { table: t } = EventsTable({
      name: "clicks",
      columns: "url String",
      orderBy: "(url, at)",
      timestamp: "at",
      timestampType: "DateTime64(3)",
      ttlDays: 30,
      partitionBy: "toDate(at)",
    });
    expect(t.props.columns.at(-1)).toEqual({ name: "at", type: "DateTime64(3)" });
    expect(t.props.ttl).toBe("at + INTERVAL 30 DAY");
    expect(t.props.partitionBy).toBe("toDate(at)");
  });
});

describe("RollupView", () => {
  const rollup = (source = events().table) =>
    RollupView({
      name: "daily_kinds",
      source,
      columns: "day Date, kind LowCardinality(String), n UInt64",
      select: "toDate(ts) AS day, kind, count() AS n",
      groupBy: "day, kind",
    });

  test("defaults: a SummingMergeTree target sorted by the grouping key, and a view named after it", () => {
    const { table: target, view } = rollup();
    expect(target.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.table);
    expect(target.props.engine).toEqual({ name: "SummingMergeTree" });
    expect(target.props.orderBy).toBe("(day, kind)");
    expect(view.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.materializedView);
    expect(view.props.name).toBe("daily_kinds_mv");
    expect(view.props.lineage.map((e) => e.output)).toEqual(["day", "kind", "n"]);
  });

  test("the view writes TO its target and reads the source, by reference", () => {
    const source = events().table;
    const { table: target, view } = rollup(source);
    expect(view.props.to).toBe(target);
    expect(view.props.reads).toEqual([source]);
    expect(view.dependsOn).toEqual([target, source]);
    expect(ddlOf(view)).toBe(
      "CREATE MATERIALIZED VIEW daily_kinds_mv TO daily_kinds AS SELECT toDate(ts) AS day, kind, count() AS n FROM events GROUP BY day, kind",
    );
  });

  test("the engine, sort key and partition key are parameters", () => {
    const { table: target } = RollupView({
      name: "daily_users",
      source: events().table,
      columns: "day Date, users AggregateFunction(uniq, UUID)",
      select: "toDate(ts) AS day, uniqState(user_id) AS users",
      groupBy: "day",
      engine: "AggregatingMergeTree",
      orderBy: "day",
      partitionBy: "toYYYYMM(day)",
    });
    expect(target.props.engine).toEqual({ name: "AggregatingMergeTree" });
    expect(target.props.orderBy).toBe("day");
    expect(target.props.partitionBy).toBe("toYYYYMM(day)");
  });
});

describe("CdcMirror", () => {
  test("defaults: `_version` and `_is_deleted` columns, both read by the engine, and a view of live rows", () => {
    const { table: mirror, current } = CdcMirror({ name: "orders", columns: "id UInt64, total Decimal(12, 2)", primaryKey: "id" });
    expect(mirror.props.columns.slice(-2)).toEqual([
      { name: "_version", type: "UInt64" },
      { name: "_is_deleted", type: "UInt8" },
    ]);
    expect(mirror.props.engine).toEqual({ name: "ReplacingMergeTree", args: ["_version", "_is_deleted"] });
    expect(mirror.props.orderBy).toBe("id");
    expect(current.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.view);
    expect(ddlOf(current)).toBe(
      "CREATE VIEW orders_current AS SELECT * EXCEPT (_version, _is_deleted) FROM orders FINAL WHERE _is_deleted = 0",
    );
    expect(current.dependsOn).toEqual([mirror]);
  });

  test("the pipeline's own column names are parameters", () => {
    const { table: mirror, current } = CdcMirror({
      name: "orders",
      columns: "id UInt64",
      primaryKey: "id",
      version: "_peerdb_version",
      deleted: "_peerdb_is_deleted",
      partitionBy: "intDiv(id, 1000000)",
    });
    expect(mirror.props.engine?.args).toEqual(["_peerdb_version", "_peerdb_is_deleted"]);
    expect(mirror.props.partitionBy).toBe("intDiv(id, 1000000)");
    expect(current.props.select).toContain("WHERE _peerdb_is_deleted = 0");
  });
});

describe("ShardedTable", () => {
  test("a local ReplicatedMergeTree table and a Distributed table over it, both ON CLUSTER", () => {
    const { local, distributed } = ShardedTable({ name: "hits", cluster: "main", columns: "id UInt64, url String", orderBy: "id" });
    expect(local.props.name).toBe("hits_local");
    expect(local.props.onCluster).toBe("main");
    expect(local.props.engine).toEqual({ name: "ReplicatedMergeTree" });
    expect(distributed.props.onCluster).toBe("main");
    expect(distributed.props.engine).toEqual({ name: "Distributed", args: ["main", "currentDatabase()", "hits_local", "rand()"] });
    expect(distributed.props.columns).toEqual(local.props.columns);
    expect(distributed.dependsOn).toEqual([local]);
  });

  test("the sharding key and partition key are parameters", () => {
    const { local, distributed } = ShardedTable({
      name: "hits",
      cluster: "main",
      columns: "id UInt64, user_id UInt64",
      orderBy: "id",
      shardingKey: "cityHash64(user_id)",
      partitionBy: "intDiv(id, 1000000)",
    });
    expect(distributed.props.engine?.args?.at(-1)).toBe("cityHash64(user_id)");
    expect(local.props.partitionBy).toBe("intDiv(id, 1000000)");
  });
});

test("a prop that is not valid SQL is refused at the interpolation that carried it", () => {
  expect(() => ReplacingTable({ name: "users", columns: "id UInt64, (", orderBy: "id" })).toThrow(SqlTemplateError);
});

// ── What the lexicon's own checks say ──────────────────────────────────

describe("the composites pass the lexicon's post-synth checks", () => {
  test("SQL101 and SQLCH101-127 find nothing in any of them", () => {
    const source = events();
    const instances: Array<[string, CompositeInstance]> = [
      ["users", ReplacingTable({ name: "users", columns: "id UInt64, email String", orderBy: "id" })],
      ["events", source],
      [
        "daily",
        RollupView({
          name: "daily_kinds",
          source: source.table,
          columns: "day Date, kind LowCardinality(String), n UInt64",
          select: "toDate(ts) AS day, kind, count() AS n",
          groupBy: "day, kind",
        }),
      ],
      ["orders", CdcMirror({ name: "orders", columns: "id UInt64, total Decimal(12, 2)", primaryKey: "id" })],
      ["hits", ShardedTable({ name: "hits", cluster: "main", columns: "id UInt64, url String", orderBy: "id" })],
    ];
    const entities = new Map<string, Declarable>();
    for (const [name, instance] of instances) for (const [k, v] of expandComposite(name, instance)) entities.set(k, v);

    const out = sqlSerializer.serialize(entities) as SerializerResult;
    const doc = JSON.parse(out.primary) as { applyOrder: string[] };
    expect(doc.applyOrder.indexOf("eventsTable")).toBeLessThan(doc.applyOrder.indexOf("dailyView"));
    expect(doc.applyOrder.indexOf("dailyTable")).toBeLessThan(doc.applyOrder.indexOf("dailyView"));
    expect(doc.applyOrder.indexOf("hitsLocal")).toBeLessThan(doc.applyOrder.indexOf("hitsDistributed"));

    const ctx = makePostSynthCtx("sql", out.primary, entities);
    const clickhouse = postSynthChecks.filter((c) => c.id.startsWith("SQLCH") || c.id === "SQL101");
    const ids = clickhouse.map((c) => c.id).sort();
    expect(ids[0]).toBe("SQL101");
    expect(ids).toContain("SQLCH101");
    expect(ids.at(-1)).toBe("SQLCH127");
    expect(clickhouse.flatMap((check) => check.check(ctx))).toEqual([]);
  });
});

// ── Provenance (#3212) ─────────────────────────────────────────────────

/**
 * Where a composite call and each of its arguments were written (chant#3597),
 * read off the fixture text: the call starts at `needle`, and an argument is the
 * `name: value` property between it and the call's closing `})`. A parameter
 * the call does not write is located at the call, with no text.
 */
function callSite(file: string, source: string, needle: string) {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture has no ${needle}`);
  const end = source.indexOf("})", start);
  const at = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { file, line: before.length, column: before[before.length - 1].length + 1 };
  };
  const call = at(start);
  const argument = (parameter: string) => {
    const m = new RegExp(`\\b${parameter}: (?:"[^"]*"|[\\w.]+)`).exec(source.slice(start, end));
    return m ? { parameter, ...at(start + m.index), text: m[0] } : { parameter, ...call };
  };
  return { call, argument };
}

type CallSite = ReturnType<typeof callSite>;

/** The origin a parameter-fed field records, locations included. */
function paramAt(sites: Record<string, CallSite>) {
  return (composite: string, instance: string, ...parameters: string[]) => ({
    kind: "composite-parameter",
    composite,
    instance,
    parameters,
    call: sites[instance].call,
    arguments: parameters.map((p) => sites[instance].argument(p)),
  });
}

/** The origin a field the composite fixes records. */
function fixedAt(sites: Record<string, CallSite>) {
  return (composite: string, instance: string) => ({ kind: "composite-literal", composite, instance, call: sites[instance].call });
}

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../..");

/**
 * A project that defines nothing itself and calls the composites through the
 * installed package's dialect subpath, as a user's project does. Core resolves
 * the subpath through `node_modules` to the package's TypeScript source and
 * follows `clickhouse.ts`'s `export * from "./composites"` and the composites
 * barrel to `events-table.ts`, which it interprets (#3247).
 */
const EVENTS = `
  import { EventsTable } from "@intentius/chant-lexicon-sql/clickhouse";

  export const events = EventsTable({ name: "events", columns: "user_id UUID, kind LowCardinality(String)", orderBy: "(kind, user_id, ts)", ttlDays: 30 });
`;

const DAILY = `
  import { RollupView } from "@intentius/chant-lexicon-sql/clickhouse";
  import { events } from "./events";

  export const daily = RollupView({
    name: "daily_kinds",
    source: events.table,
    columns: "day Date, kind LowCardinality(String), n UInt64",
    select: "toDate(ts) AS day, kind, count() AS n",
    groupBy: "day, kind",
  });
`;

describe("each field keeps its provenance when the composite is interpreted", () => {
  let dir: string;

  beforeAll(async () => {
    const path = join(repoRoot, ".cache", `sql-3212-composites-${process.pid}`);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(path, "src"), { recursive: true });
    dir = await realpath(path);
    await writeFile(join(dir, "src", "events.ts"), EVENTS);
    await writeFile(join(dir, "src", "daily.ts"), DAILY);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a field is the parameter that fed it, or fixed by the composite", async () => {
    const result = await build(join(dir, "src"), [sqlSerializer], undefined, {
      fold: true,
      lexicons: ["sql"],
      intrinsics: sqlPlugin.intrinsics?.() ?? [],
    });
    expect(result.errors).toEqual([]);
    const src = join(dir, "src");
    const sites = {
      events: callSite(join(src, "events.ts"), EVENTS, "EventsTable({"),
      daily: callSite(join(src, "daily.ts"), DAILY, "RollupView({"),
    };
    const param = paramAt(sites);
    const fixed = fixedAt(sites);

    const t = result.foldProvenance.eventsTable!.fields;
    expect(t.name).toEqual(param("EventsTable", "events", "name"));
    expect(t.ttl).toEqual(param("EventsTable", "events", "timestamp", "ttlDays"));
    expect(t.partitionBy).toEqual(param("EventsTable", "events", "partitionBy", "timestamp"));
    expect(t.orderBy).toEqual(param("EventsTable", "events", "orderBy"));
    expect(t.columns).toEqual(param("EventsTable", "events", "columns", "timestamp", "timestampType"));
    expect(t["engine.name"]).toEqual(fixed("EventsTable", "events"));
    expect(t["settings.ttl_only_drop_parts"]).toEqual(fixed("EventsTable", "events"));

    const v = result.foldProvenance.dailyView!.fields;
    expect(v.name).toEqual(param("RollupView", "daily", "name"));
    expect(v.select).toEqual(param("RollupView", "daily", "groupBy", "select"));
    // `TO ${target}` and `FROM ${props.source}` are references, not text the
    // author typed into the field, so neither governs `to` or `reads`.
    expect(v.to).toEqual(fixed("RollupView", "daily"));
    expect(result.foldProvenance.dailyTable!.fields.orderBy).toEqual(param("RollupView", "daily", "groupBy", "orderBy"));

    // A drift on the TTL is a change to `ttlDays` at the `events` call; one on
    // the engine is refused, because the composite fixes it.
    const provenance = getProvenance(result.entities.get("eventsTable")!);
    const drift = (path: string, declared: unknown, live: unknown) =>
      resolveDriftedField({ entity: "eventsTable", path, declared, live, origin: originOfPath(provenance?.paths, path), provenance });
    const ttl = drift("ttl", "ts + INTERVAL 30 DAY", "ts + INTERVAL 7 DAY").resolution;
    expect(ttl).toMatchObject({ kind: "propose-parameter", parameters: ["timestamp", "ttlDays"], instance: "events" });
    expect(ttl.sourceFile).toContain("events.ts");
    expect(drift("engine.name", "MergeTree", "ReplacingMergeTree").resolution.kind).toBe("refuse-fixed");

    // Interpreting the package's composites writes what calling them writes.
    const run = await build(join(dir, "src"), [sqlSerializer], undefined, {
      fold: false,
      lexicons: ["sql"],
      intrinsics: sqlPlugin.intrinsics?.() ?? [],
    });
    expect(run.errors).toEqual([]);
    expect(result.outputs.get("sql")).toBeDefined();
    expect(result.outputs.get("sql")).toEqual(run.outputs.get("sql"));
  });
});

// ── Postgres composites (#3286) ────────────────────────────────────────

describe("the Postgres composites", () => {
  const pgTable = (e: unknown) => (e as PostgresTable).props;
  const pgDdl = (e: unknown) => flat((e as { props: { ddl: string } }).props.ddl);
  const users = () =>
    SoftDeleteTable({ name: "users", schema: "app", columns: "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL" });

  describe("SoftDeleteTable", () => {
    test("defaults: the three timestamp columns, a view and an index over the live rows, in the public schema", () => {
      const { table: t, live, liveIndex } = SoftDeleteTable({ name: "teams", columns: "id bigint PRIMARY KEY, name text NOT NULL" });
      expect(t.entityType).toBe(POSTGRES_ENTITY_TYPES.table);
      expect(pgTable(t).schema).toBe("public");
      expect(pgTable(t).columns.map((c) => c.name)).toEqual(["id", "name", "created_at", "updated_at", "deleted_at"]);
      expect(pgTable(t).columns.slice(2).map((c) => [c.type, c.notNull ?? false, c.default])).toEqual([
        ["timestamptz", true, "now()"],
        ["timestamptz", true, "now()"],
        ["timestamptz", false, undefined],
      ]);
      expect(live.entityType).toBe(POSTGRES_ENTITY_TYPES.view);
      expect(pgDdl(live)).toBe(
        "CREATE VIEW public.teams_live WITH (security_invoker = true) AS SELECT * FROM public.teams WHERE deleted_at IS NULL",
      );
      expect(liveIndex.props.name).toBe("teams_live_idx");
      expect(liveIndex.props.where).toBe("deleted_at IS NULL");
      expect(liveIndex.props.elements.map((e) => e.column)).toEqual(["id"]);
      expect(live.dependsOn).toEqual([t]);
      expect(liveIndex.dependsOn).toEqual([t]);
    });

    test("the schema, the column names, the live key and the comment are parameters", () => {
      const app = schema`CREATE SCHEMA app`;
      const { table: t, live, liveIndex } = SoftDeleteTable({
        name: "users",
        schema: app,
        columns: "id bigint PRIMARY KEY, email text NOT NULL",
        liveKey: "email",
        createdAt: "made",
        updatedAt: "touched",
        deletedAt: "gone",
        comment: "Accounts",
      });
      expect(pgTable(t).schema).toBe("app");
      expect(pgTable(t).columns.slice(2).map((c) => c.name)).toEqual(["made", "touched", "gone"]);
      expect(pgTable(t).comment).toBe("Accounts");
      expect(pgDdl(live)).toContain("WHERE gone IS NULL");
      expect(liveIndex.props.where).toBe("gone IS NULL");
      expect(liveIndex.props.elements.map((e) => e.column)).toEqual(["email"]);
      expect(t.dependsOn).toEqual([app]);
    });
  });

  describe("AuditLogTable", () => {
    test("defaults: range-partitioned by occurred_at, the key includes it, a default partition and an actor index", () => {
      const { table: log, defaultPartition, actorIndex } = AuditLogTable({ name: "audit", schema: "app" });
      expect(pgTable(log).partitionBy).toBe("RANGE (occurred_at)");
      expect(pgTable(log).primaryKey?.columns).toEqual(["id", "occurred_at"]);
      expect(pgTable(log).columns.map((c) => c.name)).toEqual(["id", "occurred_at", "actor", "action", "subject", "details"]);
      expect(pgTable(defaultPartition).name).toBe("audit_default");
      expect(pgTable(defaultPartition).partitionOf).toBe(log);
      expect(pgTable(defaultPartition).partitionBound).toBe("DEFAULT");
      expect(actorIndex.props.elements.map((e) => e.column)).toEqual(["actor", "occurred_at"]);
      expect(defaultPartition.dependsOn).toContain(log);
    });

    test("the timestamp and actor columns are parameters", () => {
      const { table: log, actorIndex } = AuditLogTable({ name: "audit", timestamp: "at", actor: "who" });
      expect(pgTable(log).partitionBy).toBe("RANGE (at)");
      expect(pgTable(log).primaryKey?.columns).toEqual(["id", "at"]);
      expect(actorIndex.props.elements.map((e) => e.column)).toEqual(["who", "at"]);
    });
  });

  describe("JoinTable", () => {
    const sides = () => ({
      left: TenantTable({ name: "people", columns: "id bigint NOT NULL", primaryKey: "id", indexOn: "id" }).table,
      right: users().table,
    });

    test("defaults: bigint columns referencing id, cascade deletes, a composite key and the reverse index", () => {
      const { left, right } = sides();
      const { table: links, reverseIndex } = JoinTable({ name: "memberships", left, leftColumn: "person_id", right, rightColumn: "user_id" });
      expect(pgTable(links).primaryKey?.columns).toEqual(["person_id", "user_id"]);
      expect(pgTable(links).columns.map((c) => [c.name, c.type])).toEqual([
        ["person_id", "bigint"],
        ["user_id", "bigint"],
        ["created_at", "timestamptz"],
      ]);
      expect(pgTable(links).foreignKeys.map((f) => [f.columns, f.refTable, f.refColumns, f.onDelete])).toEqual([
        [["person_id"], "public.people", ["id"], "CASCADE"],
        [["user_id"], "app.users", ["id"], "CASCADE"],
      ]);
      expect(reverseIndex.props.name).toBe("memberships_reverse_idx");
      expect(reverseIndex.props.elements.map((e) => e.column)).toEqual(["user_id", "person_id"]);
      expect(links.dependsOn).toEqual(expect.arrayContaining([left, right]));
    });

    test("the keys, the types and the delete action are parameters", () => {
      const { left, right } = sides();
      const { table: links } = JoinTable({
        name: "links",
        left,
        leftKey: "tenant_id",
        leftColumn: "a",
        leftType: "uuid",
        right,
        rightKey: "email",
        rightColumn: "b",
        rightType: "text",
        onDelete: "RESTRICT",
      });
      expect(pgTable(links).columns.slice(0, 2).map((c) => c.type)).toEqual(["uuid", "text"]);
      expect(pgTable(links).foreignKeys.map((f) => [f.refColumns, f.onDelete])).toEqual([
        [["tenant_id"], "RESTRICT"],
        [["email"], "RESTRICT"],
      ]);
    });
  });

  describe("TenantTable", () => {
    test("defaults: a uuid tenant_id first, leading the primary key and the index", () => {
      const { table: t, index: byTenant } = TenantTable({
        name: "notes",
        schema: "app",
        columns: "id bigint NOT NULL, body text",
        primaryKey: "id",
        indexOn: "id",
      });
      expect(pgTable(t).columns[0]).toMatchObject({ name: "tenant_id", type: "uuid", notNull: true });
      expect(pgTable(t).primaryKey?.columns).toEqual(["tenant_id", "id"]);
      expect(byTenant.props.name).toBe("notes_tenant_idx");
      expect(byTenant.props.elements.map((e) => e.column)).toEqual(["tenant_id", "id"]);
    });

    test("the tenant column, its type and a compound key are parameters", () => {
      const { table: t, index: byTenant } = TenantTable({
        name: "notes",
        columns: "a int NOT NULL, b int NOT NULL, at timestamptz",
        primaryKey: "a, b",
        indexOn: "at DESC",
        tenant: "org_id",
        tenantType: "bigint",
      });
      expect(pgTable(t).columns[0]).toMatchObject({ name: "org_id", type: "bigint" });
      expect(pgTable(t).primaryKey?.columns).toEqual(["org_id", "a", "b"]);
      expect(byTenant.props.elements.map((e) => e.column)).toEqual(["org_id", "at"]);
    });
  });

  describe("RefreshedView", () => {
    test("defaults: a materialized view over its source and a unique index on the grouping key", () => {
      const source = users().table;
      const { view, uniqueIndex } = RefreshedView({ name: "by_email", schema: "app", source, select: "email, count(*) AS n", groupBy: "email" });
      expect(view.entityType).toBe(POSTGRES_ENTITY_TYPES.materializedView);
      expect(pgDdl(view)).toBe("CREATE MATERIALIZED VIEW app.by_email AS SELECT email, count(*) AS n FROM app.users GROUP BY email");
      expect(view.props.reads).toEqual([source]);
      expect(view.dependsOn).toContain(source);
      expect(uniqueIndex.props.unique).toBe(true);
      expect(uniqueIndex.props.name).toBe("by_email_key");
      expect(uniqueIndex.props.elements.map((e) => e.column)).toEqual(["email"]);
      expect(uniqueIndex.dependsOn).toEqual([view]);
    });

    test("the unique index's columns are a parameter", () => {
      const { uniqueIndex } = RefreshedView({
        name: "daily",
        source: users().table,
        select: "email, id, count(*) AS n",
        groupBy: "email, id",
        uniqueOn: "id, email",
      });
      expect(uniqueIndex.props.elements.map((e) => e.column)).toEqual(["id", "email"]);
    });
  });

  test("a prop that is not valid SQL is refused at the interpolation that carried it", () => {
    expect(() => TenantTable({ name: "notes", columns: "id bigint NOT NULL, (", primaryKey: "id", indexOn: "id" })).toThrow(SqlTemplateError);
  });

  test("SQLPG101 to SQLPG118 find nothing in any of them", () => {
    const people = users();
    const teams = SoftDeleteTable({ name: "teams", schema: "app", columns: "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL" });
    const members = JoinTable({ name: "memberships", schema: "app", left: people.table, leftColumn: "user_id", right: teams.table, rightColumn: "team_id" });
    const instances: Array<[string, CompositeInstance]> = [
      ["users", people],
      ["teams", teams],
      ["audit", AuditLogTable({ name: "audit", schema: "app" })],
      ["memberships", members],
      [
        "notes",
        TenantTable({ name: "notes", schema: "app", columns: "id bigint NOT NULL, body text, created_at timestamptz", primaryKey: "id", indexOn: "created_at DESC" }),
      ],
      ["sizes", RefreshedView({ name: "team_sizes", schema: "app", source: members.table, select: "team_id, count(*) AS members", groupBy: "team_id" })],
    ];
    const entities = new Map<string, Declarable>([["app", schema`CREATE SCHEMA app` as unknown as Declarable]]);
    for (const [name, instance] of instances) for (const [k, v] of expandComposite(name, instance)) entities.set(k, v);

    const out = sqlSerializer.serialize(entities) as SerializerResult;
    const doc = JSON.parse(out.primary) as { applyOrder: string[]; dialect: string };
    expect(doc.dialect).toBe("postgres");
    const at = (n: string) => doc.applyOrder.indexOf(n);
    expect(at("usersTable")).toBeLessThan(at("membershipsTable"));
    expect(at("membershipsTable")).toBeLessThan(at("sizesView"));
    expect(at("sizesView")).toBeLessThan(at("sizesUniqueIndex"));
    expect(at("auditTable")).toBeLessThan(at("auditDefaultPartition"));

    const ctx = makePostSynthCtx("sql", out.primary, entities);
    const checks = postSynthChecks.filter((c) => c.id.startsWith("SQLPG"));
    expect(checks).toHaveLength(18);
    expect(checks.flatMap((check) => check.check(ctx).map((d) => `${check.id} ${d.message}`))).toEqual([]);
  });
});

// Provenance through the package import (#3246, #3268)

const PG_APP = `
  import { schema } from "@intentius/chant-lexicon-sql/postgres";

  export const app = schema\`CREATE SCHEMA app\`;
`;

const PG_ACCOUNTS = `
  import { SoftDeleteTable, TenantTable } from "@intentius/chant-lexicon-sql/postgres";
  import { app } from "./app";

  export const users = SoftDeleteTable({ name: "users", schema: app, columns: "id bigint PRIMARY KEY, email text NOT NULL", liveKey: "email", deletedAt: "gone_at" });
  export const notes = TenantTable({ name: "notes", schema: app, columns: "id bigint NOT NULL, body text", primaryKey: "id", indexOn: "id", tenant: "org_id" });
`;

const PG_LINKS = `
  import { JoinTable } from "@intentius/chant-lexicon-sql/postgres";
  import { app } from "./app";
  import { notes, users } from "./accounts";

  export const links = JoinTable({ name: "note_users", schema: app, left: notes.table, leftColumn: "note_id", right: users.table, rightColumn: "user_id" });
`;

const PG_SIZES = `
  import { RefreshedView } from "@intentius/chant-lexicon-sql/postgres";
  import { app } from "./app";
  import { links } from "./links";

  export const sizes = RefreshedView({ name: "sizes", schema: app, source: links.table, select: "user_id, count(*) AS notes", groupBy: "user_id" });
`;

describe("each Postgres field keeps its provenance when the composite is interpreted", () => {
  let dir: string;

  beforeAll(async () => {
    const path = join(repoRoot, ".cache", `sql-3286-composites-${process.pid}`);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(path, "src"), { recursive: true });
    dir = await realpath(path);
    await writeFile(join(dir, "src", "app.ts"), PG_APP);
    await writeFile(join(dir, "src", "accounts.ts"), PG_ACCOUNTS);
    await writeFile(join(dir, "src", "links.ts"), PG_LINKS);
    await writeFile(join(dir, "src", "sizes.ts"), PG_SIZES);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a field is the parameter that fed it, or fixed by the composite", async () => {
    const result = await build(join(dir, "src"), [sqlSerializer], undefined, {
      fold: true,
      lexicons: ["sql"],
      intrinsics: sqlPlugin.intrinsics?.() ?? [],
    });
    expect(result.errors).toEqual([]);
    const src = join(dir, "src");
    const sites = {
      users: callSite(join(src, "accounts.ts"), PG_ACCOUNTS, "SoftDeleteTable({"),
      notes: callSite(join(src, "accounts.ts"), PG_ACCOUNTS, "TenantTable({"),
      links: callSite(join(src, "links.ts"), PG_LINKS, "JoinTable({"),
      sizes: callSite(join(src, "sizes.ts"), PG_SIZES, "RefreshedView({"),
    };
    const param = paramAt(sites);
    const fixed = fixedAt(sites);

    const u = result.foldProvenance.usersTable!.fields;
    expect(u.name).toEqual(param("SoftDeleteTable", "users", "name"));
    expect(u.columns).toEqual(param("SoftDeleteTable", "users", "columns", "createdAt", "deletedAt", "updatedAt"));
    expect(u.ddl).toEqual(expect.objectContaining({ kind: "composite-parameter", composite: "SoftDeleteTable" }));
    expect(result.foldProvenance.usersLiveIndex!.fields.where).toEqual(param("SoftDeleteTable", "users", "deletedAt"));

    const t = result.foldProvenance.notesTable!.fields;
    expect(t.name).toEqual(param("TenantTable", "notes", "name"));
    expect(t["primaryKey.columns"]).toEqual(param("TenantTable", "notes", "primaryKey", "tenant"));
    expect(result.foldProvenance.notesIndex!.fields.elements).toEqual(param("TenantTable", "notes", "indexOn", "tenant"));

    const l = result.foldProvenance.linksTable!.fields;
    expect(l.name).toEqual(param("JoinTable", "links", "name"));
    expect(l.foreignKeys).toEqual(param("JoinTable", "links", "leftKey", "rightKey"));
    expect(l["primaryKey.columns"]).toEqual(param("JoinTable", "links", "leftColumn", "rightColumn"));
    expect(result.foldProvenance.sizesView!.fields.query).toEqual(param("RefreshedView", "sizes", "groupBy", "select"));
    expect(result.foldProvenance.sizesUniqueIndex!.fields.unique).toEqual(fixed("RefreshedView", "sizes"));

    // A drift on a column the composite fixes is refused; one on the live-row
    // predicate is a change to `deletedAt` at the `users` call.
    const provenance = getProvenance(result.entities.get("usersLiveIndex")!);
    const drift = (path: string, declared: unknown, live: unknown) =>
      resolveDriftedField({ entity: "usersLiveIndex", path, declared, live, origin: originOfPath(provenance?.paths, path), provenance });
    const where = drift("where", "gone_at IS NULL", "deleted_at IS NULL").resolution;
    expect(where).toMatchObject({ kind: "propose-parameter", parameters: ["deletedAt"], instance: "users" });
    expect(where.sourceFile).toContain("accounts.ts");

    // Interpreting the package's composites writes what calling them writes.
    const run = await build(join(dir, "src"), [sqlSerializer], undefined, {
      fold: false,
      lexicons: ["sql"],
      intrinsics: sqlPlugin.intrinsics?.() ?? [],
    });
    expect(run.errors).toEqual([]);
    expect(result.outputs.get("sql")).toEqual(run.outputs.get("sql"));
  });
});

// Same-file entities as composite arguments (#3325)

/**
 * The schema, two composite calls and a third call reading their members, all
 * in one file: each call folds as it does with the arguments imported.
 */
const PG_ONE_FILE = `
  import { schema, JoinTable, SoftDeleteTable, TenantTable } from "@intentius/chant-lexicon-sql/postgres";

  export const app = schema\`CREATE SCHEMA app\`;
  export const users = SoftDeleteTable({ name: "users", schema: app, columns: "id bigint PRIMARY KEY, email text NOT NULL", liveKey: "email", deletedAt: "gone_at" });
  export const notes = TenantTable({ name: "notes", schema: app, columns: "id bigint NOT NULL, body text", primaryKey: "id", indexOn: "id", tenant: "org_id" });
  export const links = JoinTable({ name: "note_users", schema: app, left: notes.table, leftColumn: "note_id", right: users.table, rightColumn: "user_id" });
`;

describe("a composite call whose argument is a same-file entity folds (#3325)", () => {
  let dir: string;

  beforeAll(async () => {
    const path = join(repoRoot, ".cache", `sql-3325-composites-${process.pid}`);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(path, "src"), { recursive: true });
    dir = await realpath(path);
    await writeFile(join(dir, "src", "app.ts"), PG_ONE_FILE);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("each field keeps its parameter, and the output is what running writes", async () => {
    const options = { lexicons: ["sql"], intrinsics: sqlPlugin.intrinsics?.() ?? [] };
    const result = await build(join(dir, "src"), [sqlSerializer], undefined, { ...options, fold: true });
    expect(result.errors).toEqual([]);
    expect(result.foldDecisions.map((d) => [d.mode, d.reason])).toEqual([["fold", undefined]]);
    const file = join(dir, "src", "app.ts");
    const sites = {
      users: callSite(file, PG_ONE_FILE, "SoftDeleteTable({"),
      notes: callSite(file, PG_ONE_FILE, "TenantTable({"),
      links: callSite(file, PG_ONE_FILE, "JoinTable({"),
    };
    const param = paramAt(sites);

    const u = result.foldProvenance.usersTable!.fields;
    expect(u.name).toEqual(param("SoftDeleteTable", "users", "name"));
    expect(u.columns).toEqual(param("SoftDeleteTable", "users", "columns", "createdAt", "deletedAt", "updatedAt"));
    expect(result.foldProvenance.usersLiveIndex!.fields.where).toEqual(param("SoftDeleteTable", "users", "deletedAt"));
    expect(result.foldProvenance.notesTable!.fields["primaryKey.columns"]).toEqual(param("TenantTable", "notes", "primaryKey", "tenant"));
    const l = result.foldProvenance.linksTable!.fields;
    expect(l.name).toEqual(param("JoinTable", "links", "name"));
    expect(l.foreignKeys).toEqual(param("JoinTable", "links", "leftKey", "rightKey"));
    expect(l["primaryKey.columns"]).toEqual(param("JoinTable", "links", "leftColumn", "rightColumn"));

    const run = await build(join(dir, "src"), [sqlSerializer], undefined, { ...options, fold: false });
    expect(run.errors).toEqual([]);
    expect(result.outputs.get("sql")).toEqual(run.outputs.get("sql"));
  });
});
