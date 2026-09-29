/**
 * Typed `jsonData` and `secureJsonData` (#2951): the types reject what the
 * plugin does not read, a link to another datasource takes only a plugin
 * type Grafana offers there, and the build writes a linked datasource as
 * its uid. The `@ts-expect-error` lines are checked by scripts/typecheck.ts.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { Datasource, ExternalDatasource } from "./datasource";
import { buildGrafana, DATASOURCES_FILE } from "./build";
import { JSONDATA_LINKS, type DatasourceJsonDataTypes } from "./datasource-settings";
import { registeredQueries } from "./query";

const tempo = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200" });
const loki = new Datasource({
  name: "Loki",
  type: "loki",
  jsonData: { maxLines: "1000", derivedFields: [{ name: "traceID", matcherRegex: "traceID=(\\w+)", datasourceUid: tempo }] },
});
const pyroscope = new ExternalDatasource({ type: "grafana-pyroscope-datasource", uid: "pyro" });
const prometheus = new Datasource({
  name: "Prometheus",
  type: "prometheus",
  jsonData: {
    httpMethod: "POST",
    prometheusType: "Mimir",
    timeout: 60,
    httpHeaderName1: "X-Scope-OrgID",
    exemplarTraceIdDestinations: [{ name: "trace_id", datasourceUid: tempo }],
  },
  secureJsonData: { basicAuthPassword: "$__env{PROM_PASSWORD}", httpHeaderValue1: "$__env{TENANT}" },
});
const tempoLinked = new Datasource({
  name: "Tempo linked",
  type: "tempo",
  jsonData: {
    tracesToLogsV2: { datasourceUid: loki, customQuery: false, filterByTraceID: true },
    tracesToMetrics: { datasourceUid: prometheus, queries: [{ name: "Rate", query: "sum(rate(x[5m]))" }] },
    tracesToProfiles: { datasourceUid: pyroscope, profileTypeId: "process_cpu:cpu:nanoseconds:cpu:nanoseconds" },
    serviceMap: { datasourceUid: prometheus },
    nodeGraph: { enabled: true },
  },
});

describe("typed datasource settings", () => {
  test("a linked datasource is written as its uid", () => {
    const built = buildGrafana(new Map<string, Declarable>([["tempo", tempo], ["loki", loki], ["prometheus", prometheus], ["tempoLinked", tempoLinked], ["pyroscope", pyroscope]]));
    const yaml = load(built.files[DATASOURCES_FILE]) as { datasources: Array<{ name: string; jsonData?: Record<string, unknown> }> };
    const by = (name: string) => yaml.datasources.find((d) => d.name === name)!.jsonData;
    expect(by("Prometheus")?.exemplarTraceIdDestinations).toEqual([{ name: "trace_id", datasourceUid: "tempo" }]);
    expect(by("Loki")?.derivedFields).toEqual([{ name: "traceID", matcherRegex: "traceID=(\\w+)", datasourceUid: "tempo" }]);
    expect(by("Tempo linked")).toMatchObject({
      tracesToLogsV2: { datasourceUid: "loki" },
      tracesToMetrics: { datasourceUid: "prometheus" },
      tracesToProfiles: { datasourceUid: "pyro" },
      serviceMap: { datasourceUid: "prometheus" },
    });
  });

  test("the types reject keys and links the plugin does not take", () => {
    // @ts-expect-error an exemplar links to a tracing datasource, not to Loki
    new Datasource({ name: "P1", type: "prometheus", jsonData: { exemplarTraceIdDestinations: [{ name: "t", datasourceUid: loki }] } });
    // @ts-expect-error traces to logs does not go to a Prometheus
    new Datasource({ name: "T1", type: "tempo", jsonData: { tracesToLogsV2: { datasourceUid: prometheus } } });
    // @ts-expect-error a key Prometheus does not read
    new Datasource({ name: "P2", type: "prometheus", jsonData: { derivedFields: [] } });
    // @ts-expect-error prometheusType is one of four
    new Datasource({ name: "P3", type: "prometheus", jsonData: { prometheusType: "VictoriaMetrics" } });
    // @ts-expect-error a secure key Postgres does not read
    new Datasource({ name: "PG", type: "grafana-postgresql-datasource", secureJsonData: { apiKey: "$__env{K}" } });
    // @ts-expect-error MSSQL's encrypt is a string
    new Datasource({ name: "MS", type: "mssql", jsonData: { encrypt: true } });
    // A uid string is always accepted, and a plugin chant does not type takes any settings.
    new Datasource({ name: "P4", type: "prometheus", jsonData: { exemplarTraceIdDestinations: [{ name: "t", datasourceUid: "xray" }] } });
    new Datasource({ name: "I", type: "influxdb", jsonData: { dbName: "site" }, secureJsonData: { token: "$__env{T}" } });
    new Datasource({ name: "PGold", type: "postgres", jsonData: { sslmode: "disable", database: "grafana" } });
    expect(true).toBe(true);
  });

  test("every plugin with a query class has typed settings, and every link names typed plugins it can hold", () => {
    const typed: Record<keyof DatasourceJsonDataTypes, true> = {
      prometheus: true,
      loki: true,
      tempo: true,
      elasticsearch: true,
      cloudwatch: true,
      "grafana-azure-monitor-datasource": true,
      stackdriver: true,
      "grafana-bigquery-datasource": true,
      "grafana-pyroscope-datasource": true,
      "grafana-postgresql-datasource": true,
      postgres: true,
      mysql: true,
      mssql: true,
    };
    const withClass = registeredQueries()
      .filter((d) => d.builtin)
      .flatMap((d) => [d.datasourceType, ...(d.aliases ?? [])]);
    expect(withClass.sort()).toEqual(Object.keys(typed).sort());
    for (const link of JSONDATA_LINKS) {
      expect(link.path.at(-1)).toMatch(/Uid$/);
      expect(link.targets.length).toBeGreaterThan(0);
    }
  });
});
