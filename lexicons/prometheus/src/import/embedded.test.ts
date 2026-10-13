import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { prometheusPlugin } from "../plugin";
import { alertmanagerImporter, prometheusConfigImporter, ruleGroupsImporter } from "./embedded";

const GROUPS = [
  { name: "api", rules: [{ alert: "ApiDown", expr: "up{job=\"api\"} == 0", for: "5m" }] },
  { name: "recording", rules: [{ record: "job:up:sum", expr: "sum by (job) (up)" }] },
];

const RULE_FILE = `groups:
  - name: api
    rules:
      - alert: ApiDown
        expr: up{job="api"} == 0
        for: 5m
`;

const site = (over: Partial<EmbeddedContent>): EmbeddedContent => ({
  host: "k8s",
  hostType: "K8s::Monitoring::PrometheusRule",
  location: "PrometheusRule api spec.groups",
  directory: "api",
  ...over,
});

describe("rule groups embedded in another lexicon's resource (#2962)", () => {
  test("the plugin registers the importers", () => {
    expect(prometheusPlugin.embeddedImporters?.()).toEqual([ruleGroupsImporter, alertmanagerImporter, prometheusConfigImporter]);
  });

  test("matches a PrometheusRule's groups and a rule file held as text; not an alertmanager.yml", () => {
    expect(ruleGroupsImporter.matches(site({ document: { groups: GROUPS }, select: "groups" }))).toBe(true);
    expect(ruleGroupsImporter.matches(site({ text: RULE_FILE, document: embeddedDocument(RULE_FILE) }))).toBe(true);
    const am = "route:\n  receiver: x\nreceivers:\n  - name: x\n";
    expect(ruleGroupsImporter.matches(site({ text: am, document: embeddedDocument(am) }))).toBe(false);
  });

  test("spec.groups becomes the list of declared groups, in the source's order", () => {
    const out = ruleGroupsImporter.import(site({ document: { groups: GROUPS }, select: "groups" }));
    expect(out.files.map((f) => f.path)).toEqual(["rules.ts"]);
    expect(out.value).toEqual({
      bindings: [
        { from: "rules.ts", name: "api" },
        { from: "rules.ts", name: "recording" },
      ],
      shape: "list",
    });
  });

  test("a rule file held as text goes through ruleFileYaml", () => {
    const out = ruleGroupsImporter.import(site({ text: RULE_FILE, document: embeddedDocument(RULE_FILE) }));
    expect(out.value.through).toEqual({ from: "@intentius/chant-lexicon-prometheus", name: "ruleFileYaml" });
    expect(out.value.bindings).toEqual([{ from: "rules.ts", name: "api" }]);
  });
});

const ALERTMANAGER = `route:
  receiver: team
  routes:
    - matchers: [severity="critical"]
      receiver: pager
      mute_time_intervals: [nights]
receivers:
  - name: team
  - name: pager
time_intervals:
  - name: nights
    time_intervals:
      - times: [{ start_time: "22:00", end_time: "24:00" }]
inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
templates: [/etc/alertmanager/*.tmpl]
`;

describe("an alertmanager.yml embedded in another lexicon's resource (#3031)", () => {
  const configMap = (text: string) =>
    site({ hostType: "K8s::Core::ConfigMap", location: 'ConfigMap am data["alertmanager.yml"]', text, document: embeddedDocument(text) });

  test("matches an alertmanager.yml held as text; not a rule file, nor a selected member", () => {
    expect(alertmanagerImporter.matches(configMap(ALERTMANAGER))).toBe(true);
    expect(alertmanagerImporter.matches(configMap(RULE_FILE))).toBe(false);
    expect(alertmanagerImporter.matches(site({ document: { groups: GROUPS }, select: "groups" }))).toBe(false);
    expect(ruleGroupsImporter.matches(configMap(ALERTMANAGER))).toBe(false);
  });

  test("becomes alertmanagerYaml over every declaration the standalone import writes", () => {
    const out = alertmanagerImporter.import(configMap(ALERTMANAGER));
    expect(out.files.map((f) => f.path)).toEqual(["receivers.ts", "time-intervals.ts", "routes.ts", "inhibit-rules.ts", "settings.ts"]);
    expect(out.value).toEqual({
      bindings: [
        { from: "receivers.ts", name: "team" },
        { from: "receivers.ts", name: "pager" },
        { from: "time-intervals.ts", name: "nights" },
        { from: "routes.ts", name: "root" },
        { from: "inhibit-rules.ts", name: "inhibitRule1" },
        { from: "settings.ts", name: "settings" },
      ],
      shape: "list",
      through: { from: "@intentius/chant-lexicon-prometheus", name: "alertmanagerYaml" },
    });
    expect(out.warnings).toEqual([]);
  });
});

const PROMETHEUS = `global:
  scrape_interval: 15s
rule_files:
  - /etc/prometheus/rules.yml
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ["node:9100"]
  - job_name: api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
`;

describe("a prometheus.yml embedded in another lexicon's resource (#3365)", () => {
  const configMap = (text: string) =>
    site({ hostType: "K8s::Core::ConfigMap", location: 'ConfigMap prometheus data["prometheus.yml"]', text, document: embeddedDocument(text) });

  test("matches a prometheus.yml held as text; not a rule file, an alertmanager.yml, nor a selected member", () => {
    expect(prometheusConfigImporter.matches(configMap(PROMETHEUS))).toBe(true);
    expect(prometheusConfigImporter.matches(configMap(RULE_FILE))).toBe(false);
    expect(prometheusConfigImporter.matches(configMap(ALERTMANAGER))).toBe(false);
    expect(prometheusConfigImporter.matches(configMap("storage:\n  path: /data\n"))).toBe(false);
    expect(prometheusConfigImporter.matches(site({ document: { scrape_configs: [] }, select: "groups" }))).toBe(false);
    expect(ruleGroupsImporter.matches(configMap(PROMETHEUS))).toBe(false);
    expect(alertmanagerImporter.matches(configMap(PROMETHEUS))).toBe(false);
  });

  test("becomes prometheusConfigYaml over every declaration the standalone import writes", () => {
    const out = prometheusConfigImporter.import(configMap(PROMETHEUS));
    expect(out.files.map((f) => f.path)).toEqual(["scrape-configs.ts", "prometheus.ts"]);
    expect(out.value).toEqual({
      bindings: [
        { from: "scrape-configs.ts", name: "node" },
        { from: "scrape-configs.ts", name: "api" },
        { from: "prometheus.ts", name: "prometheus" },
      ],
      shape: "list",
      through: { from: "@intentius/chant-lexicon-prometheus", name: "prometheusConfigYaml" },
    });
    expect(out.warnings).toEqual([]);
  });
});
