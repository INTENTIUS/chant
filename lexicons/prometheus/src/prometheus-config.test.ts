/**
 * `prometheus.yml` as entities: `PrometheusConfig` and `ScrapeConfig` build to
 * the file, the serializer writes it beside the other files, and
 * `promtool check config` accepts it when `promtool` is on PATH.
 *
 * The import round trip is in import/prometheus-roundtrip.test.ts.
 */

import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { buildPrometheusConfig, prometheusConfigYaml } from "./build";
import { PrometheusConfig, ScrapeConfig, isPrometheusConfig, isScrapeConfig } from "./prometheus-config";
import { prometheusSerializer, PROMETHEUS_FILE, ALERTMANAGER_FILE } from "./serializer";
import { Receiver, Route, RuleGroup } from "./index";
import { hasTool, promtoolCheckConfig } from "./tools";
import { CATALOG } from "./catalog";
import { detectTemplate } from "./detect";
import { PrometheusParser } from "./import/parser";
import type { SerializerResult } from "@intentius/chant/serializer";

const PROMTOOL = hasTool(process.env.PROMTOOL ?? "promtool");

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

/** What terragucci's observability/prometheus.ts emits today. */
const terragucci = () => ({
  config: new PrometheusConfig({ global: { scrape_interval: "5s" } }),
  collector: new ScrapeConfig({ job_name: "otel-collector", static_configs: [{ targets: ["otel-collector:8889"] }] }),
});

const TERRAGUCCI_YAML = `global:
  scrape_interval: 5s
scrape_configs:
  - job_name: otel-collector
    static_configs:
      - targets:
          - otel-collector:8889
`;

describe("PrometheusConfig and ScrapeConfig", () => {
  test("the guards tell the two entities apart", () => {
    const { config, collector } = terragucci();
    expect(isPrometheusConfig(config)).toBe(true);
    expect(isScrapeConfig(config)).toBe(false);
    expect(isScrapeConfig(collector)).toBe(true);
    expect(isPrometheusConfig(collector)).toBe(false);
  });

  test("both are in the catalog", () => {
    const names = CATALOG.filter((c) => c.file === "prometheus.yml").map((c) => c.className);
    expect(names.sort()).toEqual(["PrometheusConfig", "ScrapeConfig"]);
  });

  test("the config terragucci emits today builds to the same text", () => {
    expect(prometheusConfigYaml(Object.values(terragucci()) as unknown as Declarable[])).toBe(TERRAGUCCI_YAML);
  });

  test("sections come out in Prometheus's order and scrape jobs are sorted by name", () => {
    const built = buildPrometheusConfig([
      new ScrapeConfig({ job_name: "zeta", static_configs: [{ targets: ["z:1"] }] }),
      new ScrapeConfig({ job_name: "alpha", static_configs: [{ targets: ["a:1"] }] }),
      new PrometheusConfig({
        otlp: { promote_resource_attributes: ["service.name"] },
        rule_files: ["rules/*.yml"],
        global: { scrape_interval: "15s", external_labels: { cluster: "dev" } },
        alerting: { alertmanagers: [{ static_configs: [{ targets: ["alertmanager:9093"] }] }] },
        remote_write: [{ url: "http://mimir:9009/api/v1/push" }],
      }),
    ]);
    expect(Object.keys(built.config)).toEqual(["global", "alerting", "rule_files", "scrape_configs", "remote_write", "otlp"]);
    expect(built.config.scrape_configs?.map((j) => j.job_name)).toEqual(["alpha", "zeta"]);
    expect(built.warnings).toEqual([]);
    expect(built.count).toBe(3);
  });

  test("scrape jobs written inline in PrometheusConfig are merged with declared ones", () => {
    const declared = new ScrapeConfig({ job_name: "declared", static_configs: [{ targets: ["d:1"] }] });
    const built = buildPrometheusConfig([
      declared,
      new PrometheusConfig({ scrape_configs: [declared, { job_name: "inline", static_configs: [{ targets: ["i:1"] }] }] }),
    ]);
    expect(built.config.scrape_configs?.map((j) => j.job_name)).toEqual(["declared", "inline"]);
  });

  test("undefined fields are dropped", () => {
    const yaml = prometheusConfigYaml([new ScrapeConfig({ job_name: "a", scrape_interval: undefined, honor_labels: false })]);
    expect(load(yaml)).toEqual({ scrape_configs: [{ job_name: "a", honor_labels: false }] });
  });

  test("a repeated job_name and a second PrometheusConfig are warnings", () => {
    const built = buildPrometheusConfig([
      new ScrapeConfig({ job_name: "dup" }),
      new ScrapeConfig({ job_name: "dup" }),
      new PrometheusConfig({ global: { scrape_interval: "1s" } }),
      new PrometheusConfig({ global: { scrape_interval: "2s" } }),
    ]);
    expect(built.warnings).toHaveLength(2);
    expect(built.config.global?.scrape_interval).toBe("1s");
  });

  test("an unlisted discovery kind is carried as written", () => {
    const yaml = prometheusConfigYaml([
      new ScrapeConfig({ job_name: "docker", docker_sd_configs: [{ host: "unix:///var/run/docker.sock" }] }),
    ]);
    expect(load(yaml)).toEqual({
      scrape_configs: [{ job_name: "docker", docker_sd_configs: [{ host: "unix:///var/run/docker.sock" }] }],
    });
  });
});

describe("prometheus serializer with prometheus.yml", () => {
  test("a build with only scrape configs writes prometheus.yml as the primary output", () => {
    expect(prometheusSerializer.serialize(entities(terragucci()))).toBe(TERRAGUCCI_YAML);
  });

  test("a build with no prometheus.yml entities is unchanged", () => {
    const out = prometheusSerializer.serialize(
      entities({ g: new RuleGroup({ name: "g", rules: [{ record: "a:b", expr: "sum(up)" }] }) }),
    );
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/^groups:/);
  });

  test("with rule groups, prometheus.yml is written beside the rule file", () => {
    const out = prometheusSerializer.serialize(
      entities({ ...terragucci(), g: new RuleGroup({ name: "g", rules: [{ record: "a:b", expr: "sum(up)" }] }) }),
    ) as SerializerResult;
    expect(out.primary).toMatch(/^groups:/);
    expect(out.files).toEqual({ [PROMETHEUS_FILE]: TERRAGUCCI_YAML });
  });

  test("with rule groups and Alertmanager entities, all three files are written", () => {
    const hook = new Receiver({ name: "hook", webhook_configs: [{ url: "http://hook:8080/" }] });
    const out = prometheusSerializer.serialize(
      entities({
        ...terragucci(),
        g: new RuleGroup({ name: "g", rules: [{ record: "a:b", expr: "sum(up)" }] }),
        route: new Route({ receiver: hook }),
      }),
    ) as SerializerResult;
    expect(out.primary).toMatch(/^groups:/);
    expect(Object.keys(out.files ?? {})).toEqual([PROMETHEUS_FILE, ALERTMANAGER_FILE]);
  });

  test("with Alertmanager entities only, prometheus.yml is primary and alertmanager.yml beside it", () => {
    const hook = new Receiver({ name: "hook", webhook_configs: [{ url: "http://hook:8080/" }] });
    const out = prometheusSerializer.serialize(entities({ ...terragucci(), route: new Route({ receiver: hook }) })) as SerializerResult;
    expect(out.primary).toBe(TERRAGUCCI_YAML);
    expect(Object.keys(out.files ?? {})).toEqual([ALERTMANAGER_FILE]);
  });

  test("warnings travel with the output", () => {
    const out = prometheusSerializer.serialize(
      entities({ a: new ScrapeConfig({ job_name: "dup" }), b: new ScrapeConfig({ job_name: "dup" }) }),
    ) as SerializerResult;
    expect(out.warnings).toHaveLength(1);
  });
});

describe("prometheus.yml detection and parsing", () => {
  test("a prometheus.yml is a template of this lexicon; a bare global block or a collector config is not", () => {
    expect(detectTemplate(load(TERRAGUCCI_YAML))).toBe(true);
    expect(detectTemplate({ global: { scrape_interval: "5s" } })).toBe(true);
    expect(detectTemplate({ global: { resolve_timeout: "5m" } })).toBe(false);
    expect(detectTemplate({ receivers: { otlp: {} }, exporters: {} })).toBe(false);
    expect(detectTemplate({ apiVersion: "v1", kind: "ConfigMap", global: { scrape_interval: "5s" } })).toBe(false);
  });

  test("the parser names what it does not carry", () => {
    const ir = new PrometheusParser().parse(`scrape_configs:
  - job_name: a
    docker_sd_configs: [{ host: "unix:///x.sock" }]
  - static_configs: [{ targets: ["x:1"] }]
bogus: 1
`);
    expect(ir.resources[0].type).toBe("Prometheus::Config");
    expect(ir.warnings).toHaveLength(3);
    expect(ir.warnings?.join("\n")).toContain("docker_sd_configs");
    expect(ir.warnings?.join("\n")).toContain("has no job_name");
    expect(ir.warnings?.join("\n")).toContain('"bogus"');
  });
});

describe("promtool check config", () => {
  test.skipIf(!PROMTOOL)("accepts the config terragucci emits", () => {
    const r = promtoolCheckConfig(prometheusConfigYaml(Object.values(terragucci()) as unknown as Declarable[]));
    expect(r.ok, r.output).toBe(true);
  });

  test.skipIf(!PROMTOOL)("accepts a config using the typed sections", () => {
    const yaml = prometheusConfigYaml([
      new PrometheusConfig({
        global: { scrape_interval: "15s", scrape_timeout: "10s", evaluation_interval: "30s", external_labels: { cluster: "dev" } },
        alerting: { alertmanagers: [{ scheme: "http", api_version: "v2", static_configs: [{ targets: ["alertmanager:9093"] }] }] },
        rule_files: ["rules.yml"],
        remote_write: [
          {
            url: "http://mimir:9009/api/v1/push",
            queue_config: { capacity: 10000 },
            write_relabel_configs: [{ source_labels: ["__name__"], regex: "debug_.*", action: "drop" }],
          },
        ],
        otlp: { promote_resource_attributes: ["service.name"] },
      }),
      new ScrapeConfig({
        job_name: "app",
        scrape_interval: "5s",
        params: { format: ["prometheus"] },
        static_configs: [{ targets: ["app:8080"], labels: { tier: "web" } }],
        metric_relabel_configs: [{ source_labels: ["__name__"], regex: "go_.*", action: "drop" }],
      }),
      new ScrapeConfig({
        job_name: "dns",
        dns_sd_configs: [{ names: ["api.service.internal"], type: "A", port: 9100 }],
        relabel_configs: [{ source_labels: ["__address__"], target_label: "host" }],
      }),
    ]);
    const r = promtoolCheckConfig(yaml, { "rules.yml": "groups:\n  - name: g\n    rules:\n      - record: a:b\n        expr: sum(up)\n" });
    expect(r.ok, r.output).toBe(true);
  });

  test.skipIf(!PROMTOOL)("rejects a config Prometheus rejects", () => {
    const r = promtoolCheckConfig(prometheusConfigYaml([new ScrapeConfig({ job_name: "bad", scrape_interval: "1s", scrape_timeout: "5s" })]));
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
  });
});
