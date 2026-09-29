import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { prometheusPlugin } from "../plugin";
import { ruleGroupsImporter } from "./embedded";

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
  test("the plugin registers the importer", () => {
    expect(prometheusPlugin.embeddedImporters?.()).toEqual([ruleGroupsImporter]);
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
