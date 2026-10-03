/**
 * The ClickHouse composites: their props and defaults, the entity types they
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
import { CdcMirror, EventsTable, ReplacingTable, RollupView, ShardedTable } from "./index";
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
  test("SQLCH101-120 find nothing in any of them", () => {
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
    const clickhouse = postSynthChecks.filter((c) => c.id.startsWith("SQLCH"));
    const ids = clickhouse.map((c) => c.id).sort();
    expect(ids[0]).toBe("SQLCH101");
    expect(ids.at(-1)).toBe("SQLCH120");
    expect(clickhouse.flatMap((check) => check.check(ctx))).toEqual([]);
  });
});

// ── Provenance (#3212) ─────────────────────────────────────────────────

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

/** In its own file: a same-file reference to another composite call's member falls back to run. */
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
    const param = (composite: string, instance: string, ...parameters: string[]) => ({
      kind: "composite-parameter",
      composite,
      instance,
      parameters,
    });
    const fixed = (composite: string, instance: string) => ({ kind: "composite-literal", composite, instance });

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
