/**
 * Stream engines (#4396): a change to a Kafka or S3Queue table is SQLCH225
 * and not SQLCH223, the plan holds nothing back for it, the statements go
 * detach, drop, create, attach, and a replacement that loses position says so.
 */

import { describe, expect, test } from "vitest";
import { canonicalObject } from "./normalize";
import { diffSchemas, type SchemaObject } from "./diff";
import { renderDiff } from "./report";
import { classifyDisruption } from "./disruption";
import { CLASSIFIER_RULES } from "./rules";
import { rebuildOpSuggestions } from "./rebuild-handoff";
import { isStreamEngine, readsTable, STREAM_ENGINES, streamEngineArguments } from "./stream";
import { planStatements, type DeclaredObject } from "../apply/statements";
import { CLICKHOUSE_ENTITY_TYPES } from "../entities";
import { observeRebuild, RebuildRefusal } from "../rebuild/observe";
import type { ClickHouseTarget } from "../live/bind";

const KAFKA = (topics: string, group = "ingest", extra = "") =>
  `CREATE TABLE shop.events_stream (user_id UInt64, kind String) ENGINE = Kafka(kafka_creds) SETTINGS kafka_topic_list = '${topics}', kafka_group_name = '${group}', kafka_format = 'JSONEachRow'${extra}`;
const S3QUEUE = (path: string, mode = "unordered") =>
  `CREATE TABLE shop.files_stream (user_id UInt64) ENGINE = S3Queue(lake_creds) SETTINGS mode = '${mode}', keeper_path = '${path}'`;
const MV = "CREATE MATERIALIZED VIEW shop.events_mv TO shop.events AS SELECT user_id, kind FROM shop.events_stream";
const MV_OTHER = "CREATE MATERIALIZED VIEW shop.audit_mv TO shop.audit AS SELECT user_id FROM events_stream";
const MV_UNRELATED = "CREATE MATERIALIZED VIEW shop.other_mv TO shop.other AS SELECT user_id FROM shop.users";

const obj = (key: string, ddl: string): SchemaObject => ({ key, canonical: canonicalObject(ddl) });
const one = (key: string, before: string, after: string) => diffSchemas([obj(key, before)], [obj(key, after)]);

describe("stream engines", () => {
  test("the six engines are the ones the pinned catalog has", () => {
    expect([...STREAM_ENGINES].sort()).toEqual(["AzureQueue", "FileLog", "Kafka", "NATS", "RabbitMQ", "S3Queue"]);
    expect(isStreamEngine("MergeTree")).toBe(false);
    expect(isStreamEngine(undefined)).toBe(false);
  });

  test("the rule is its own class, with a rule id in the SQLCH2xx range", () => {
    expect(CLASSIFIER_RULES.SQLCH225.class).toBe("replace");
    expect(CLASSIFIER_RULES.SQLCH223.class).toBe("rebuild");
  });
});

describe("classification", () => {
  test("a different topic list is SQLCH225, not SQLCH223, and the plan refuses nothing", () => {
    const diff = one("events_stream", KAFKA("events"), KAFKA("events,clicks"));
    expect(diff.changes.map((c) => [c.rule, c.class, c.field])).toEqual([["SQLCH225", "replace", "settings.kafka_topic_list"]]);
    expect(diff.rebuilds).toEqual([]);
    expect(rebuildOpSuggestions(diff, new Map([["events_stream", canonicalObject(KAFKA("events,clicks"))]]), "prod")).toEqual([]);
  });

  test("a topic list given as an engine argument is the engine changing", () => {
    const positional = (topic: string) => `CREATE TABLE shop.q (a String) ENGINE = Kafka('broker:9092', '${topic}', 'g', 'JSONEachRow')`;
    const diff = one("q", positional("a"), positional("b"));
    expect(diff.changes.map((c) => [c.rule, c.field])).toEqual([["SQLCH225", "engine"]]);
  });

  test("a format, a column and a setting added are all the stream rule", () => {
    const diff = one(
      "events_stream",
      KAFKA("events"),
      KAFKA("events", "ingest", ", kafka_num_consumers = 2").replace("kafka_format = 'JSONEachRow'", "kafka_format = 'CSV'").replace("kind String", "kind String, ts DateTime"),
    );
    expect(new Set(diff.changes.map((c) => c.rule))).toEqual(new Set(["SQLCH225"]));
    expect(diff.changes.map((c) => c.field).sort()).toEqual(["columns.ts", "settings.kafka_format", "settings.kafka_num_consumers"]);
  });

  test("S3Queue, RabbitMQ and NATS tables are stream tables too", () => {
    expect(one("f", S3QUEUE("/q/a"), S3QUEUE("/q/a", "ordered")).changes.map((c) => c.rule)).toEqual(["SQLCH225"]);
    const nats = (subject: string) => `CREATE TABLE shop.n (a String) ENGINE = NATS(nats_creds) SETTINGS nats_subjects = '${subject}', nats_format = 'JSONEachRow'`;
    expect(one("n", nats("a"), nats("b")).changes.map((c) => c.rule)).toEqual(["SQLCH225"]);
    const rabbit = (queue: string) => `CREATE TABLE shop.r (a String) ENGINE = RabbitMQ(rabbit_creds) SETTINGS rabbitmq_queue_base = '${queue}', rabbitmq_format = 'JSONEachRow'`;
    expect(one("r", rabbit("a"), rabbit("b")).changes.map((c) => c.rule)).toEqual(["SQLCH225"]);
  });

  test("a comment alone stays metadata", () => {
    const diff = one("events_stream", KAFKA("events"), `${KAFKA("events")} COMMENT 'ingest'`);
    expect(diff.changes.map((c) => c.rule)).toEqual(["SQLCH203"]);
  });

  test("a MergeTree engine change is still SQLCH223", () => {
    const mt = (v: string) => `CREATE TABLE shop.t (a UInt64, v UInt64) ENGINE = ReplacingMergeTree(${v}) ORDER BY a`;
    expect(one("t", mt("v"), mt("a")).changes.map((c) => c.rule)).toEqual(["SQLCH223"]);
  });

  test("a table that becomes a stream table is a rebuild with a note, and gets no Op suggestion", () => {
    const mt = "CREATE TABLE shop.events_stream (user_id UInt64, kind String) ENGINE = MergeTree ORDER BY user_id";
    const diff = one("events_stream", mt, KAFKA("events"));
    expect(diff.changes[0]).toMatchObject({ rule: "SQLCH223", class: "rebuild" });
    expect(diff.changes[0]!.note).toMatch(/stream engine/);
    expect(rebuildOpSuggestions(diff, new Map([["events_stream", canonicalObject(KAFKA("events"))]]), "prod")).toEqual([]);
  });

  test("the report counts the class and names the views that are detached around the replacement", () => {
    const diff = diffSchemas(
      [obj("events_stream", KAFKA("events")), obj("events_mv", MV), obj("audit_mv", MV_OTHER), obj("other_mv", MV_UNRELATED)],
      [obj("events_stream", KAFKA("clicks")), obj("events_mv", MV), obj("audit_mv", MV_OTHER), obj("other_mv", MV_UNRELATED)],
    );
    const text = renderDiff(diff);
    expect(text).toMatch(/\[replace table\] settings\.kafka_topic_list/);
    expect(text).toMatch(/SQLCH225 Change a stream table/);
    expect(text).toMatch(/1 replace table/);
    expect(text).toMatch(/hint: shop\.events_stream is replaced: shop\.events_mv, shop\.audit_mv read it and are detached first and attached after/);
    expect(text).not.toMatch(/Refused/);
  });
});

describe("position", () => {
  test("a different kafka_group_name warns, naming both groups", () => {
    const [c] = one("events_stream", KAFKA("events", "ingest"), KAFKA("events", "ingest-v2")).changes;
    expect(c!.rule).toBe("SQLCH225");
    expect(c!.note).toMatch(/loses its position: kafka_group_name changes from ingest to ingest-v2/);
    expect(c!.note).toMatch(/committed offsets, or from the start of the topic/);
  });

  test("a group given as an engine argument is read too", () => {
    const positional = (g: string) => `CREATE TABLE shop.q (a String) ENGINE = Kafka('broker:9092', 't', '${g}', 'JSONEachRow')`;
    expect(one("q", positional("g1"), positional("g2")).changes[0]!.note).toMatch(/from g1 to g2/);
  });

  test("a topic list change keeps the group, so there is no warning", () => {
    expect(one("events_stream", KAFKA("events"), KAFKA("clicks")).changes[0]!.note).toBeUndefined();
  });

  test("a different S3Queue keeper_path warns that every file is processed again", () => {
    const [c] = one("files_stream", S3QUEUE("/q/a"), S3QUEUE("/q/b")).changes;
    expect(c!.rule).toBe("SQLCH225");
    expect(c!.note).toMatch(/keeper_path changes from \/q\/a to \/q\/b: .*every file already seen is processed again/);
  });

  test("the same keeper_path with another mode does not warn", () => {
    expect(one("files_stream", S3QUEUE("/q/a"), S3QUEUE("/q/a", "ordered")).changes[0]!.note).toBeUndefined();
  });
});

describe("reading a table", () => {
  const table = canonicalObject(KAFKA("events"));
  test("a view reads it by a bare name in its own database, or by a qualified one", () => {
    expect(readsTable(canonicalObject(MV), table)).toBe(true);
    expect(readsTable(canonicalObject(MV_OTHER), table)).toBe(true);
    expect(readsTable(canonicalObject("CREATE MATERIALIZED VIEW audit.mv TO audit.t AS SELECT a FROM shop.events_stream"), table)).toBe(true);
  });
  test("a view of another table, another database's table of the same name, or a plain view is not a reader", () => {
    expect(readsTable(canonicalObject(MV_UNRELATED), table)).toBe(false);
    expect(readsTable(canonicalObject("CREATE MATERIALIZED VIEW audit.mv TO audit.t AS SELECT a FROM events_stream"), table)).toBe(false);
    expect(readsTable(canonicalObject("CREATE VIEW shop.v AS SELECT a FROM shop.events_stream"), table)).toBe(false);
    expect(readsTable(canonicalObject("CREATE MATERIALIZED VIEW shop.mv TO shop.t AS SELECT a FROM shop.events_stream_old"), table)).toBe(false);
  });
  test("engine arguments split outside quotes and parentheses", () => {
    expect(streamEngineArguments("Kafka('a, b:9092', 't', 'g', 'JSONEachRow')")).toEqual(["a, b:9092", "t", "g", "JSONEachRow"]);
    expect(streamEngineArguments("Kafka")).toEqual([]);
  });
});

const declared = (key: string, type: DeclaredObject["type"], ddl: string): DeclaredObject => ({ exportName: key, type, key, ddl, canonical: canonicalObject(ddl), dependsOn: [] });

describe("the statements", () => {
  const before = [KAFKA("events"), MV, MV_OTHER, MV_UNRELATED].map((d) => canonicalObject(d));
  const names = ["shop.events_stream", "shop.events_mv", "shop.audit_mv", "shop.other_mv"];
  const current = new Map(names.map((n, i) => [n, before[i]!]));
  const after = [
    declared("shop.events_stream", CLICKHOUSE_ENTITY_TYPES.table, KAFKA("clicks")),
    declared("shop.events_mv", CLICKHOUSE_ENTITY_TYPES.materializedView, MV),
    declared("shop.audit_mv", CLICKHOUSE_ENTITY_TYPES.materializedView, MV_OTHER),
    declared("shop.other_mv", CLICKHOUSE_ENTITY_TYPES.materializedView, MV_UNRELATED),
  ];
  const changes = diffSchemas(
    names.map((n, i) => ({ key: n, canonical: before[i]! })),
    after.map((o) => ({ key: o.key, canonical: o.canonical })),
  ).changes;
  const stepsOf = (plan: ReturnType<typeof planStatements>, i = 0) => (plan.objects[i] as { steps: { sql: string; rule: string; class: string }[] }).steps;

  test("detach the views that read the table, replace it, attach them again", () => {
    const plan = planStatements({ declared: after, changes, current });
    expect(plan.objects[0]!.verdict).toBe("alter");
    expect(stepsOf(plan).map((s) => s.sql.replace(/\s+/g, " "))).toEqual([
      "DETACH TABLE `shop`.`events_mv`",
      "DETACH TABLE `shop`.`audit_mv`",
      "DROP TABLE `shop`.`events_stream` SYNC",
      expect.stringMatching(/^CREATE TABLE shop\.events_stream \(user_id UInt64, kind String\) ENGINE = Kafka\(kafka_creds\) SETTINGS kafka_topic_list = 'clicks', .* COMMENT '.*managed-by=chant/),
      "ATTACH TABLE `shop`.`events_mv`",
      "ATTACH TABLE `shop`.`audit_mv`",
    ]);
    expect(stepsOf(plan).every((s) => s.rule === "SQLCH225" && s.class === "replace")).toBe(true);
  });

  test("the views themselves have nothing to do, and the unrelated one is not touched", () => {
    const plan = planStatements({ declared: after, changes, current });
    expect(plan.objects.slice(1).map((o) => [o.verdict, (o as { steps: unknown[] }).steps.length])).toEqual([
      ["alter", 0],
      ["alter", 0],
      ["alter", 0],
    ]);
  });

  test("a view the build drops in the same plan is not detached", () => {
    const gone = [...changes, { object: "shop.audit_mv", field: "object", rule: "SQLCH250" as const, class: "drop" as const }];
    const plan = planStatements({ declared: after.slice(0, 2), changes: gone, current });
    expect(stepsOf(plan).filter((s) => s.sql.startsWith("DETACH")).map((s) => s.sql)).toEqual(["DETACH TABLE `shop`.`events_mv`"]);
  });

  test("on a cluster each statement runs ON CLUSTER", () => {
    const plan = planStatements({ declared: after, changes, current, topology: { kind: "cluster", cluster: "main" } as never });
    expect(stepsOf(plan).every((s) => /ON CLUSTER/.test(s.sql))).toBe(true);
  });
});

describe("classifyDisruption", () => {
  test("a stream engine's setting replaces; a MergeTree setting stays in place", () => {
    const out = classifyDisruption({
      environment: "prod",
      changes: [
        { name: "events_stream", type: "ClickHouse::Table", deltas: [{ path: "settings.kafka_topic_list" } as never] },
        { name: "events", type: "ClickHouse::Table", deltas: [{ path: "settings.merge_with_ttl_timeout" } as never] },
      ],
    });
    expect(out.events_stream).toMatchObject({ disruption: "replace" });
    expect(out.events_stream!.detail).toMatch(/SQLCH225/);
    expect(out.events).toMatchObject({ disruption: "in-place" });
  });
});

describe("ClickHouseRebuildOp's observation", () => {
  const target = { endpoint: { url: "http://unreachable.invalid" }, defaultDatabase: "shop" } as unknown as ClickHouseTarget;

  test.each([
    ["Kafka", KAFKA("events")],
    ["S3Queue", S3QUEUE("/q/a")],
  ])("refuses a %s table by name, before it asks the server anything", async (engine, ddl) => {
    const o = declared("shop.t", CLICKHOUSE_ENTITY_TYPES.table, ddl);
    const err = await observeRebuild(target, o, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RebuildRefusal);
    expect((err as Error).message).toContain(`the ${engine} engine`);
    expect((err as Error).message).toMatch(/SQLCH225/);
    expect((err as Error).message).toMatch(/stores no rows/);
  });
});
