/**
 * A contrib v0.130.0 collector with `create_schema: false` writes logs,
 * traces and every metric type into tables built from the sql lexicon's
 * `OtelTables` (#4397).
 *
 * A scratch ClickHouse of the sql lexicon's pinned image gets the tables
 * `OtelTables` declares, created from their DDL in the serializer's apply
 * order, so the exporter finds them and creates nothing. A collector of
 * `COLLECTOR_IMAGE` on the same Docker network runs the config chant builds
 * from a `ClickHouseExporter`. One OTLP/HTTP request per signal goes in, and
 * every table, the trace-id lookup table filled by its materialized view
 * included, must then hold a row. Skips cleanly without Docker.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { OtelTables } from "@intentius/chant-lexicon-sql/clickhouse";
import { sqlSerializer } from "@intentius/chant-lexicon-sql/serializer";
import { dockerAvailable, startScratchServer, type ScratchServer } from "@intentius/chant-lexicon-sql/clickhouse/container";
import { clickhouseQuery } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";
import { collectorYaml } from "./collector";
import { ClickHouseExporter, OtlpReceiver } from "./components";
import { Pipeline } from "./pipeline";
import { COLLECTOR_IMAGE } from "./platform";

const exec = promisify(execFile);
const enabled = await dockerAvailable();
const DB = "otel_4397";
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const network = `chant-otel-4397-${suffix}`;
const collectorName = `chant-otel-4397-col-${suffix}`;
const dir = mkdtempSync(join(tmpdir(), "chant-otel-4397-"));
let server: ScratchServer | undefined;
let otlpUrl = "";

const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(server!.endpoint, sql);

/** The tables, from `OtelTables`, in the order the sql serializer applies them. */
function tablesDdl(): string[] {
  const entities = new Map<string, Declarable>();
  for (const [k, v] of expandComposite("otel", OtelTables({ database: DB }))) entities.set(k, v);
  const primary = (sqlSerializer.serialize(entities) as SerializerResult).primary;
  const order = (JSON.parse(primary) as { applyOrder: string[] }).applyOrder;
  return order.map((k) => (entities.get(k) as unknown as { props: { ddl: string } }).props.ddl);
}

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-otel-4397-ch" });
  await q(`CREATE DATABASE ${DB}`);
  for (const ddl of tablesDdl()) await q(ddl);

  const otlp = new OtlpReceiver({ protocols: { http: { endpoint: "0.0.0.0:4318" } } });
  const clickhouse = new ClickHouseExporter({ endpoint: `tcp://${server.name}:9000`, database: DB, create_schema: false, async_insert: false });
  const yaml = collectorYaml([
    otlp,
    clickhouse,
    ...(["logs", "traces", "metrics"] as const).map((signal) => new Pipeline({ signal, receivers: [otlp], exporters: [clickhouse] })),
  ]);
  writeFileSync(join(dir, "config.yaml"), yaml);

  await exec("docker", ["network", "create", network]);
  await exec("docker", ["network", "connect", network, server.name]);
  await exec(
    "docker",
    ["run", "-d", "--name", collectorName, "--network", network, "-p", "127.0.0.1::4318", "-v", `${dir}:/etc/otelcol-contrib:ro`, COLLECTOR_IMAGE, "--config=/etc/otelcol-contrib/config.yaml"],
    { timeout: 600_000 },
  );
  const { stdout } = await exec("docker", ["port", collectorName, "4318/tcp"]);
  otlpUrl = `http://${stdout.trim().split("\n")[0]}`;
}, 900_000);

afterAll(async () => {
  await exec("docker", ["rm", "-f", collectorName]).catch(() => undefined);
  await server?.stop();
  await exec("docker", ["network", "rm", network]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const now = BigInt(Date.now()) * 1_000_000n;
const ns = (offsetMs = 0) => String(now + BigInt(offsetMs) * 1_000_000n);
const resource = { attributes: [{ key: "service.name", value: { stringValue: "chant-e2e" } }] };
const TRACE_ID = "5b8efff798038103d269b633813fc60c";

const PAYLOADS: Record<string, unknown> = {
  "/v1/logs": {
    resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "e2e" }, logRecords: [{ timeUnixNano: ns(), severityText: "INFO", severityNumber: 9, body: { stringValue: "hello" }, traceId: TRACE_ID }] }] }],
  },
  "/v1/traces": {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: "e2e" },
            spans: [
              {
                traceId: TRACE_ID,
                spanId: "eee19b7ec3c1b174",
                name: "op",
                kind: 2,
                startTimeUnixNano: ns(),
                endTimeUnixNano: ns(5),
                events: [{ timeUnixNano: ns(1), name: "evt" }],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  },
  "/v1/metrics": {
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            scope: { name: "e2e" },
            metrics: [
              { name: "g", gauge: { dataPoints: [{ timeUnixNano: ns(), asDouble: 1 }] } },
              { name: "s", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ startTimeUnixNano: ns(-1000), timeUnixNano: ns(), asInt: "3" }] } },
              {
                name: "h",
                histogram: { aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: ns(-1000), timeUnixNano: ns(), count: "2", sum: 3, bucketCounts: ["1", "1"], explicitBounds: [1] }] },
              },
              {
                name: "eh",
                exponentialHistogram: {
                  aggregationTemporality: 2,
                  dataPoints: [{ startTimeUnixNano: ns(-1000), timeUnixNano: ns(), count: "2", sum: 3, scale: 0, zeroCount: "0", positive: { offset: 0, bucketCounts: ["2"] } }],
                },
              },
              { name: "sm", summary: { dataPoints: [{ startTimeUnixNano: ns(-1000), timeUnixNano: ns(), count: "2", sum: 3, quantileValues: [{ quantile: 0.5, value: 1 }] }] } },
            ],
          },
        ],
      },
    ],
  },
};

/** POST until the collector takes it: it is still starting for the first few seconds. */
async function send(path: string, body: unknown): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${otlpUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return;
      last = `${res.status} ${await res.text()}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the collector did not take ${path}: ${last}`);
}

const TABLES = [
  "otel_logs",
  "otel_traces",
  "otel_traces_trace_id_ts",
  "otel_metrics_gauge",
  "otel_metrics_sum",
  "otel_metrics_summary",
  "otel_metrics_histogram",
  "otel_metrics_exponential_histogram",
];

describe.skipIf(!enabled)(`a ${COLLECTOR_IMAGE} clickhouse exporter writes into OtelTables (#4397)`, () => {
  test(
    "logs, traces and every metric type land in the declared tables, and the exporter created none",
    async () => {
      for (const [path, body] of Object.entries(PAYLOADS)) await send(path, body);

      const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await q<{ n: string }>(`SELECT count() AS n FROM ${DB}.${t}`))[0].n)] as const)));
      const deadline = Date.now() + 120_000;
      let seen = await counts();
      while (Object.values(seen).some((n) => n === 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        seen = await counts();
      }
      if (Object.values(seen).some((n) => n === 0)) {
        const logs = await exec("docker", ["logs", "--tail", "60", collectorName]).catch((e) => ({ stdout: "", stderr: String(e) }));
        console.error(logs.stdout, logs.stderr);
      }
      expect(Object.entries(seen).filter(([, n]) => n === 0).map(([t]) => t)).toEqual([]);

      const [span] = await q<{ ServiceName: string; SpanName: string; events: string }>(`SELECT ServiceName, SpanName, length(Events.Name) AS events FROM ${DB}.otel_traces`);
      expect(span).toMatchObject({ ServiceName: "chant-e2e", SpanName: "op" });
      expect(Number(span.events)).toBe(1);

      // create_schema: false: the database holds the declared tables and view, and nothing else.
      const objects = (await q<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${DB}' ORDER BY name`)).map((r) => r.name);
      expect(objects).toEqual([...TABLES, "otel_traces_trace_id_ts_mv"].sort());
    },
    300_000,
  );
});
