import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { prometheusPlugin } from "../plugin";
import { alertmanagerImporter, ruleGroupsImporter } from "./embedded";

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
    expect(prometheusPlugin.embeddedImporters?.()).toEqual([ruleGroupsImporter, alertmanagerImporter]);
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
