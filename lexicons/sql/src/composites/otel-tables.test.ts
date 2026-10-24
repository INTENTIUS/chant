/**
 * `OtelTables` (#4397): the tables the OpenTelemetry Collector's clickhouse
 * exporter writes, as its create statements at contrib v0.130.0 declare them.
 */

import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseObject, type ClickHouseTable, type TableProps, type ViewProps } from "../clickhouse/entities";
import { sqlSerializer } from "../serializer";
import { postSynthChecks } from "../lint/post-synth";
import { sqlWorkspaceOutputs } from "../workspace-outputs";
import { OtelTables, otelTtlClause } from "./index";

const props = (e: unknown) => (e as ClickHouseObject & { props: TableProps }).props;
const columns = (e: unknown) => props(e).columns.map((c) => c.name);

describe("OtelTables", () => {
  test("defaults: the exporter's seven tables, unqualified, plus the trace-id lookup table and view", () => {
    const t = OtelTables({});
    expect(Object.entries(t).map(([k, e]) => [k, (e as Declarable).entityType, props(e).database, props(e).name])).toEqual([
      ["logs", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_logs"],
      ["traces", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_traces"],
      ["metricsGauge", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_metrics_gauge"],
      ["metricsSum", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_metrics_sum"],
      ["metricsSummary", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_metrics_summary"],
      ["metricsHistogram", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_metrics_histogram"],
      ["metricsExponentialHistogram", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_metrics_exponential_histogram"],
      ["traceIdTs", CLICKHOUSE_ENTITY_TYPES.table, undefined, "otel_traces_trace_id_ts"],
      ["traceIdTsView", CLICKHOUSE_ENTITY_TYPES.materializedView, undefined, "otel_traces_trace_id_ts_mv"],
    ]);
    expect(props(t.logs).ttl).toBeUndefined();
    expect(props(t.logs).engine).toEqual({ name: "MergeTree" });
    expect(props(t.logs).settings).toEqual({ index_granularity: "8192", ttl_only_drop_parts: "1" });
  });

  test("the columns of the exporter's create statements, in their order", () => {
    const t = OtelTables({});
    expect(columns(t.logs)).toEqual([
      "Timestamp", "TimestampTime", "TraceId", "SpanId", "TraceFlags", "SeverityText", "SeverityNumber", "ServiceName", "Body",
      "ResourceSchemaUrl", "ResourceAttributes", "ScopeSchemaUrl", "ScopeName", "ScopeVersion", "ScopeAttributes", "LogAttributes",
    ]);
    expect(columns(t.traces)).toEqual([
      "Timestamp", "TraceId", "SpanId", "ParentSpanId", "TraceState", "SpanName", "SpanKind", "ServiceName", "ResourceAttributes",
      "ScopeName", "ScopeVersion", "SpanAttributes", "Duration", "StatusCode", "StatusMessage", "Events", "Links",
    ]);
    const head = [
      "ResourceAttributes", "ResourceSchemaUrl", "ScopeName", "ScopeVersion", "ScopeAttributes", "ScopeDroppedAttrCount", "ScopeSchemaUrl",
      "ServiceName", "MetricName", "MetricDescription", "MetricUnit", "Attributes", "StartTimeUnix", "TimeUnix",
    ];
    expect(columns(t.metricsGauge)).toEqual([...head, "Value", "Flags", "Exemplars"]);
    expect(columns(t.metricsSum)).toEqual([...head, "Value", "Flags", "Exemplars", "AggregationTemporality", "IsMonotonic"]);
    expect(columns(t.metricsSummary)).toEqual([...head, "Count", "Sum", "ValueAtQuantiles", "Flags"]);
    expect(columns(t.metricsHistogram)).toEqual([...head, "Count", "Sum", "BucketCounts", "ExplicitBounds", "Exemplars", "Flags", "Min", "Max", "AggregationTemporality"]);
    expect(columns(t.metricsExponentialHistogram)).toEqual([
      ...head, "Count", "Sum", "Scale", "ZeroCount", "PositiveOffset", "PositiveBucketCounts", "NegativeOffset", "NegativeBucketCounts",
      "Exemplars", "Flags", "Min", "Max", "AggregationTemporality",
    ]);
    expect(columns(t.traceIdTs)).toEqual(["TraceId", "Start", "End"]);
    expect(props(t.logs).columns.find((c) => c.name === "Timestamp")?.codec).toBe("Delta(8), ZSTD(1)");
    expect(props(t.traces).columns.find((c) => c.name === "Events")?.type?.replace(/\s+/g, " ")).toBe(
      "Nested ( Timestamp DateTime64(9), Name LowCardinality(String), Attributes Map(LowCardinality(String), String) )",
    );
    expect(props(t.logs).indexes.map((i) => i.name)).toEqual([
      "idx_trace_id", "idx_res_attr_key", "idx_res_attr_value", "idx_scope_attr_key", "idx_scope_attr_value", "idx_log_attr_key", "idx_log_attr_value", "idx_body",
    ]);
  });

  test("database, ttl and table names reach every member; the view reads the traces table into the lookup table", () => {
    const t = OtelTables({ database: "otel", ttl: "72h", tables: { traces: "spans", exponentialHistogram: "otel_metrics_exp_histogram" } });
    expect(props(t.traces)).toMatchObject({ database: "otel", name: "spans", ttl: "toDateTime(Timestamp) + toIntervalDay(3)" });
    expect(props(t.logs).ttl).toBe("TimestampTime + toIntervalDay(3)");
    expect(props(t.metricsExponentialHistogram)).toMatchObject({ name: "otel_metrics_exp_histogram", ttl: "toDateTime(TimeUnix) + toIntervalDay(3)" });
    expect(props(t.traceIdTs)).toMatchObject({ database: "otel", name: "spans_trace_id_ts", ttl: "toDateTime(Start) + toIntervalDay(3)" });
    const view = (t.traceIdTsView as unknown as { props: ViewProps }).props;
    expect(view.name).toBe("spans_trace_id_ts_mv");
    expect(view.to).toBe(t.traceIdTs);
    expect(view.reads).toEqual([t.traces]);
  });

  test("traceIdLookup: false leaves out the lookup table and view", () => {
    const t = OtelTables({ traceIdLookup: false });
    expect(Object.keys(t)).not.toContain("traceIdTs");
    expect(Object.keys(t)).not.toContain("traceIdTsView");
  });

  test("the TTL is rendered as the exporter's GenerateTTLExpr renders it", () => {
    expect(otelTtlClause(undefined, "t")).toBe("");
    expect(otelTtlClause("0", "t")).toBe("");
    expect(otelTtlClause("48h", "t")).toBe("TTL t + toIntervalDay(2)");
    expect(otelTtlClause("12h", "t")).toBe("TTL t + toIntervalHour(12)");
    expect(otelTtlClause("1h30m", "t")).toBe("TTL t + toIntervalMinute(90)");
    expect(otelTtlClause("90s", "t")).toBe("TTL t + toIntervalSecond(90)");
    expect(() => otelTtlClause("3d", "t")).toThrow(/not a Go duration/);
  });

  test("passes the lexicon's post-synth checks, and orders the view after both tables", () => {
    const entities = new Map<string, Declarable>();
    for (const [k, v] of expandComposite("otel", OtelTables({ database: "otel", ttl: "72h" }))) entities.set(k, v);
    const out = sqlSerializer.serialize(entities) as SerializerResult;
    const doc = JSON.parse(out.primary) as { applyOrder: string[] };
    expect(doc.applyOrder.indexOf("otelTraces")).toBeLessThan(doc.applyOrder.indexOf("otelTraceIdTsView"));
    expect(doc.applyOrder.indexOf("otelTraceIdTs")).toBeLessThan(doc.applyOrder.indexOf("otelTraceIdTsView"));
    const ctx = makePostSynthCtx("sql", out.primary, entities);
    const checks = postSynthChecks.filter((c) => c.id.startsWith("SQLCH") || c.id === "SQL101");
    expect(checks.flatMap((check) => check.check(ctx))).toEqual([]);
  });

  test("its tables and columns are workspace outputs another member can link to", () => {
    const entities = new Map<string, Declarable>();
    for (const [k, v] of expandComposite("otel", OtelTables({ database: "otel" }))) entities.set(k, v);
    const names = sqlWorkspaceOutputs(entities)!.outputs.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["otel.otel_logs", "otel.otel_logs.Body", "otel.otel_traces.Events", "otel.otel_traces_trace_id_ts_mv"]));
    expect((OtelTables({}).logs as ClickHouseTable).entityType).toBe(CLICKHOUSE_ENTITY_TYPES.table);
  });
});
