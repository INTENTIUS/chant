/**
 * The clickhouse exporter's tables (#4397): which tables and columns an
 * exporter config writes, OTEL129 over a build root that also declares them
 * with the sql lexicon's `OtelTables`, and the workspace links the otel
 * lexicon states for them.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "@intentius/chant/build";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { OtelTables } from "@intentius/chant-lexicon-sql/clickhouse";
import { sqlSerializer } from "@intentius/chant-lexicon-sql/serializer";
import { CLICKHOUSE_EXPORTER_COLUMNS, clickhouseExportersOf, clickhouseExporterTargets } from "./clickhouse-tables";
import { collectorYaml } from "./collector";
import { ClickHouseExporter, OtlpReceiver, BatchProcessor } from "./components";
import { Pipeline } from "./pipeline";
import { otel129 } from "./lint/post-synth/otel129";
import { otelPlugin } from "./plugin";
import { otelSerializer } from "./serializer";
import { otelWorkspaceLinks } from "./workspace-links";
import { pkgDir } from "./import/testdata/fixtures";

const ALL = new Set(["logs", "traces", "metrics"]);

describe("clickhouseExporterTargets", () => {
  test("the exporter's defaults at v0.130.0: database default, otel_* tables, create_schema true", () => {
    const t = clickhouseExporterTargets("clickhouse", { endpoint: "tcp://ch:9000" }, ALL);
    expect(t.database).toBe("default");
    expect(t.createSchema).toBe(true);
    expect(t.tables.map((x) => x.name)).toEqual([
      "otel_logs",
      "otel_traces",
      "otel_metrics_gauge",
      "otel_metrics_sum",
      "otel_metrics_summary",
      "otel_metrics_histogram",
      "otel_metrics_exponential_histogram",
    ]);
  });

  test("database: the option wins unless it is default, then the endpoint's path", () => {
    expect(clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000/fromdsn", database: "otel" }, ALL).database).toBe("otel");
    expect(clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000/fromdsn", database: "default" }, ALL).database).toBe("fromdsn");
    expect(clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000/fromdsn" }, ALL).database).toBe("fromdsn");
  });

  test("only the tables of the signals whose pipelines use the exporter", () => {
    const t = clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000", traces_table_name: "spans" }, new Set(["traces"]));
    expect(t.tables.map((x) => [x.key, x.name])).toEqual([["traces_table_name", "spans"]]);
  });

  test("metric names: metrics_tables per type; the deprecated metrics_table_name is a prefix only when none is set", () => {
    const named = clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000", metrics_table_name: "m", metrics_tables: { sum: { name: "s" } } }, new Set(["metrics"]));
    expect(named.tables.map((x) => x.name)).toEqual(["otel_metrics_gauge", "s", "otel_metrics_summary", "otel_metrics_histogram", "otel_metrics_exponential_histogram"]);
    const prefixed = clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000", metrics_table_name: "m" }, new Set(["metrics"]));
    expect(prefixed.tables.map((x) => x.name)).toEqual(["m_gauge", "m_sum", "m_summary", "m_histogram", "m_exponential_histogram"]);
  });

  test("a value read from the environment is not guessed", () => {
    const t = clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000", database: "${env:CH_DB}" }, ALL);
    expect(t.tables).toEqual([]);
    expect(t.unread).toEqual(["database ${env:CH_DB}"]);
    const named = clickhouseExporterTargets("c", { endpoint: "tcp://ch:9000", logs_table_name: "${env:T}" }, new Set(["logs"]));
    expect(named.tables).toEqual([]);
    expect(named.unread).toEqual(["logs_table_name ${env:T}"]);
  });

  test("the insert columns are columns OtelTables declares, Nested fields under their column", () => {
    const t = OtelTables({});
    const cols = (e: unknown) => (e as { props: { columns: Array<{ name: string }> } }).props.columns.map((c) => c.name);
    expect(cols(t.logs)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.logs]));
    expect(cols(t.traces)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.traces]));
    expect(cols(t.metricsGauge)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.gauge]));
    expect(cols(t.metricsSum)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.sum]));
    expect(cols(t.metricsSummary)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.summary]));
    expect(cols(t.metricsHistogram)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.histogram]));
    expect(cols(t.metricsExponentialHistogram)).toEqual(expect.arrayContaining([...CLICKHOUSE_EXPORTER_COLUMNS.exponential_histogram]));
  });
});

describe("ClickHouseExporter", () => {
  test("is a built-in at COLLECTOR_PIN, with an endpoint check", () => {
    expect(ClickHouseExporter.definition.builtin).toBe(true);
    expect(ClickHouseExporter.definition.pin.version).toBe("v0.130.0");
    const validate = ClickHouseExporter.definition.validate as (c: unknown) => string[];
    expect(validate({ endpoint: "" })).toEqual(["endpoint is empty; the exporter requires it"]);
    expect(validate({ endpoint: "clickhouse 9000" })[0]).toMatch(/is not a URL/);
    expect(validate({ endpoint: "${env:CH_URL}" })).toEqual([]);
    expect(validate({ endpoint: "tcp://ch:9000" })).toEqual([]);
  });
});

/** A collector writing every signal through one clickhouse exporter. */
function collector(exporter: Record<string, unknown>): Declarable[] {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
  const batch = new BatchProcessor({});
  const clickhouse = new ClickHouseExporter({ endpoint: "tcp://clickhouse:9000", ...exporter } as never);
  return [
    otlp,
    batch,
    clickhouse,
    ...(["logs", "traces", "metrics"] as const).map((signal) => new Pipeline({ signal, receivers: [otlp], processors: [batch], exporters: [clickhouse] })),
  ];
}

function ctxOf(otel: Declarable[], sql: object): PostSynthContext {
  const entities = new Map<string, Declarable>();
  otel.forEach((e, i) => entities.set(`otel${i}`, e));
  for (const [k, e] of Object.entries(sql)) if (e) entities.set(k, e as Declarable);
  return { outputs: new Map([["otel", collectorYaml(otel)]]), entities, buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 } } as PostSynthContext;
}

describe("OTEL129: the exporter's tables against the sql build in the same root", () => {
  test("silent when the build declares the tables and create_schema is false", () => {
    expect(otel129.check(ctxOf(collector({ database: "otel", create_schema: false }), OtelTables({ database: "otel" })))).toEqual([]);
  });

  test("a renamed table fails, naming the exporter's key and the declared tables", () => {
    const diags = otel129.check(ctxOf(collector({ database: "otel", create_schema: false }), OtelTables({ database: "otel", tables: { logs: "app_logs" } })));
    expect(diags.map((d) => [d.checkId, d.severity, d.entity])).toEqual([["OTEL129", "error", "clickhouse"]]);
    expect(diags[0].message).toMatch(/writes logs to otel\.otel_logs \(logs_table_name\), which the sql build does not declare/);
    expect(diags[0].message).toContain("otel.app_logs");
  });

  test("another database fails every table", () => {
    const diags = otel129.check(ctxOf(collector({ create_schema: false }), OtelTables({ database: "otel" })));
    expect(diags).toHaveLength(7);
    expect(diags.every((d) => d.severity === "error" && /default\.otel_/.test(d.message))).toBe(true);
  });

  test("a column the insert names but the table lacks fails", () => {
    const tables = OtelTables({}) as unknown as Record<string, Declarable>;
    const logs = tables.logs as unknown as { props: { columns: Array<{ name: string }> } };
    logs.props.columns = logs.props.columns.filter((c) => c.name !== "Body" && c.name !== "LogAttributes");
    const diags = otel129.check(ctxOf(collector({ create_schema: false }), tables));
    expect(diags.map((d) => d.message)).toEqual([expect.stringMatching(/inserts logs into default\.otel_logs with columns Body, LogAttributes, which the declared table does not have/)]);
  });

  test("create_schema left at true warns for the declared tables", () => {
    const diags = otel129.check(ctxOf(collector({}), OtelTables({})));
    expect(diags.map((d) => [d.severity, d.entity])).toEqual([["warning", "clickhouse"]]);
    expect(diags[0].message).toMatch(/create_schema true \(the default\).*default\.otel_logs/);
  });

  test("a root with no sql ClickHouse tables is not checked", () => {
    expect(otel129.check(ctxOf(collector({}), {}))).toEqual([]);
  });

  test("runs in a real build of one root that uses both lexicons, and fails when a table is renamed", async () => {
    // A fresh project per build: a module once imported is not read again.
    const run = async (logs: string) => {
      const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
      try {
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["otel", "sql"] };\n');
        writeFileSync(join(dir, "package.json"), '{ "name": "otel-clickhouse-root", "private": true, "type": "module" }\n');
        writeFileSync(
          join(dir, "src", "main.ts"),
          [
            'import { ClickHouseExporter, OtlpReceiver, Pipeline } from "@intentius/chant-lexicon-otel";',
            'import { OtelTables } from "@intentius/chant-lexicon-sql/clickhouse";',
            `export const otelTables = OtelTables({ database: "otel", tables: { logs: "${logs}" } });`,
            'export const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });',
            'export const clickhouse = new ClickHouseExporter({ endpoint: "tcp://clickhouse:9000", database: "otel", create_schema: false });',
            'export const logs = new Pipeline({ signal: "logs", receivers: [otlp], exporters: [clickhouse] });',
            "",
          ].join("\n"),
        );
        const result = await build(join(dir, "src"), [otelSerializer, sqlSerializer]);
        expect(result.errors).toEqual([]);
        // chant build hands each lexicon's checks its own output and every entity.
        return otel129.check({ outputs: new Map([["otel", result.outputs.get("otel")!]]), entities: result.entities, buildResult: result } as PostSynthContext);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(await run("otel_logs")).toEqual([]);
    expect((await run("otel_logs_v2")).map((d) => [d.checkId, d.severity])).toEqual([["OTEL129", "error"]]);
  });
});

describe("the otel lexicon's workspace links", () => {
  test("each table the exporter writes, and each column its insert names anchored on the table", () => {
    const entities = new Map<string, Declarable>();
    collector({ database: "otel", create_schema: false }).forEach((e, i) => entities.set(i === 2 ? "clickhouse" : `e${i}`, e));
    const links = otelPlugin.workspaceLinks!(entities)!;
    expect(links.gaps).toBeUndefined();
    const tables = links.links.filter((l) => !l.anchor).map((l) => l.output);
    expect(tables).toEqual([
      "otel.otel_logs",
      "otel.otel_traces",
      "otel.otel_metrics_gauge",
      "otel.otel_metrics_sum",
      "otel.otel_metrics_summary",
      "otel.otel_metrics_histogram",
      "otel.otel_metrics_exponential_histogram",
    ]);
    expect(links.links).toContainEqual({ output: "otel.otel_traces.Events", anchor: "otel.otel_traces", entity: "clickhouse" });
    expect(links.links.every((l) => l.entity === "clickhouse")).toBe(true);
  });

  test("an environment-set database is a gap; a project with no clickhouse exporter states none", () => {
    const entities = new Map<string, Declarable>();
    collector({ database: "${env:CH_DB}" }).forEach((e, i) => entities.set(`e${i}`, e));
    expect(otelWorkspaceLinks(entities)).toEqual({ links: [], gaps: [expect.stringMatching(/sets database \$\{env:CH_DB\}, which is read from the environment/)] });
    expect(otelWorkspaceLinks(new Map([["otlp", new OtlpReceiver({})]]))).toBeUndefined();
  });

  test("clickhouseExportersOf skips an exporter no pipeline uses", () => {
    expect(clickhouseExportersOf({ exporters: { clickhouse: { endpoint: "tcp://x:9000" } }, service: { pipelines: {} } })).toEqual([]);
  });
});
