/**
 * `StreamIngest` (#4396): the stream table, the view and the MergeTree
 * target it declares, the references between them, and what the lexicon's own
 * checks say about a chain that names a named collection and about one that
 * writes a password.
 */

import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { StreamIngest } from "./index";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseObject } from "../clickhouse/entities";
import { sqlSerializer } from "../serializer";
import { postSynthChecks } from "../lint/post-synth";
import { diffStatements } from "../migration-statements";

const flat = (ddl: string) => ddl.replace(/\s+/g, " ").trim();
const ddlOf = (entity: unknown) => flat((entity as ClickHouseObject & { props: { ddl: string } }).props.ddl);

const ingest = (over: Partial<Parameters<typeof StreamIngest>[0]> = {}) =>
  StreamIngest({
    name: "events",
    columns: "ts DateTime, user_id UInt64, kind LowCardinality(String)",
    engine: "Kafka(kafka_creds)",
    settings: "kafka_topic_list = 'events', kafka_group_name = 'ingest', kafka_format = 'JSONEachRow'",
    orderBy: "(kind, user_id, ts)",
    ...over,
  });

describe("StreamIngest", () => {
  test("a target, a stream table named after it, and a view from the one into the other", () => {
    const { target, stream, view } = ingest();
    expect(target.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.table);
    expect(stream.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.table);
    expect(view.entityType).toBe(CLICKHOUSE_ENTITY_TYPES.materializedView);
    expect([target.props.name, stream.props.name, view.props.name]).toEqual(["events", "events_stream", "events_mv"]);
    expect(target.props.engine).toEqual({ name: "MergeTree" });
    expect(stream.props.engine).toMatchObject({ name: "Kafka" });
  });

  test("the DDL: the named collection is the engine's argument, the settings follow, the view selects everything", () => {
    const { stream, view, target } = ingest();
    expect(ddlOf(stream)).toBe(
      "CREATE TABLE events_stream (ts DateTime, user_id UInt64, kind LowCardinality(String)) ENGINE = Kafka(kafka_creds) SETTINGS kafka_topic_list = 'events', kafka_group_name = 'ingest', kafka_format = 'JSONEachRow'",
    );
    expect(ddlOf(view)).toBe("CREATE MATERIALIZED VIEW events_mv TO events AS SELECT * FROM events_stream");
    expect(ddlOf(target)).toBe("CREATE TABLE events (ts DateTime, user_id UInt64, kind LowCardinality(String)) ENGINE = MergeTree ORDER BY (kind, user_id, ts)");
  });

  test("the view writes TO the target and reads the stream table, by reference, so the build orders all three", () => {
    const { target, stream, view } = ingest();
    expect(view.props.to).toBe(target);
    expect(view.props.reads).toEqual([stream]);
    expect(view.dependsOn).toEqual([target, stream]);
  });

  test("the message columns, the select list, the target engine and the partition key are parameters", () => {
    const { stream, view, target } = ingest({
      streamColumns: "payload String",
      select: "parseDateTimeBestEffort(JSONExtractString(payload, 'ts')) AS ts, JSONExtractUInt(payload, 'user_id') AS user_id, JSONExtractString(payload, 'kind') AS kind",
      targetEngine: "ReplacingMergeTree",
      partitionBy: "toYYYYMM(ts)",
      engine: "S3Queue(lake_creds)",
      settings: "mode = 'unordered', keeper_path = '/chant/events'",
    });
    expect(ddlOf(stream)).toBe("CREATE TABLE events_stream (payload String) ENGINE = S3Queue(lake_creds) SETTINGS mode = 'unordered', keeper_path = '/chant/events'");
    expect(ddlOf(view)).toMatch(/^CREATE MATERIALIZED VIEW events_mv TO events AS SELECT parseDateTimeBestEffort\(/);
    expect(target.props.engine).toEqual({ name: "ReplacingMergeTree" });
    expect(target.props.partitionBy).toBe("toYYYYMM(ts)");
  });

  test("an engine with no settings declares none", () => {
    expect(ddlOf(ingest({ engine: "Kafka(kafka_creds)", settings: undefined }).stream)).toMatch(/ENGINE = Kafka\(kafka_creds\)$/);
  });

  function build(props: Parameters<typeof ingest>[0]) {
    const entities = new Map<string, Declarable>();
    for (const [k, v] of expandComposite("events", ingest(props))) entities.set(k, v);
    const out = sqlSerializer.serialize(entities) as SerializerResult;
    return { out, doc: JSON.parse(out.primary) as { applyOrder: string[]; namedCollections?: string[] }, entities };
  }
  const findings = (b: ReturnType<typeof build>) => {
    const ctx = makePostSynthCtx("sql", b.out.primary, b.entities);
    return postSynthChecks.filter((c) => c.id.startsWith("SQLCH") || c.id === "SQL101").flatMap((check) => check.check(ctx));
  };

  test("the build applies the target and the stream table before the view, records the collection, and the lexicon's checks find nothing", () => {
    const b = build({ columns: "ts DateTime, user_id UInt64, kind LowCardinality(String)", select: "ts, user_id, kind", streamColumns: "ts DateTime, user_id UInt64, kind LowCardinality(String)" });
    const order = b.doc.applyOrder;
    expect(order.indexOf("eventsTarget")).toBeLessThan(order.indexOf("eventsView"));
    expect(order.indexOf("eventsStream")).toBeLessThan(order.indexOf("eventsView"));
    expect(b.doc.namedCollections).toEqual(["kafka_creds"]);
    expect(findings(b)).toEqual([]);
  });

  test("a view that writes a column the target lacks is SQLCH110, and a password in the engine is SQLCH128", () => {
    const wrong = findings(build({ select: "ts, user_id, kind, extra" }));
    expect(wrong.map((f) => f.checkId)).toContain("SQLCH110");
    const inline = findings(build({ engine: "Kafka('broker:9092', 'events', 'ingest', 'JSONEachRow')", settings: "kafka_sasl_password = 'hunter2'" }));
    expect(inline.map((f) => f.checkId)).toContain("SQLCH128");
  });

  test("a change to the stream table between two builds is a replacement in the migration's statements, not an Op", () => {
    const settings = (topic: string) => `kafka_topic_list = '${topic}', kafka_group_name = 'ingest', kafka_format = 'JSONEachRow'`;
    const doc = diffStatements(build({ settings: settings("events") }).out.primary, build({ settings: settings("events,clicks") }).out.primary);
    expect(doc.refused).toBeFalsy();
    const steps = doc.steps.filter((s) => s.kind === "statement") as { sql: string; rule: string; class: string }[];
    expect(steps.map((s) => s.sql.replace(/\s+/g, " ").split(" ").slice(0, 2).join(" "))).toEqual(["DETACH TABLE", "DROP TABLE", "CREATE TABLE", "ATTACH TABLE"]);
    expect(steps.every((s) => s.rule === "SQLCH225" && s.class === "replace")).toBe(true);
    expect(doc.steps.every((s) => s.kind === "statement")).toBe(true);
  });
});
