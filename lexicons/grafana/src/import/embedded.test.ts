import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { grafanaPlugin } from "../plugin";
import { dashboardImporter } from "./embedded";
import { operatorImporter } from "./operator";

const DASHBOARD = JSON.stringify({
  title: "API",
  uid: "api",
  schemaVersion: 41,
  panels: [{ type: "stat", title: "Requests", gridPos: { h: 4, w: 6, x: 0, y: 0 }, targets: [{ refId: "A", expr: "sum(up)" }] }],
});

const site = (text: string): EmbeddedContent => ({
  host: "k8s",
  hostType: "K8s::Core::ConfigMap",
  location: 'ConfigMap dashboards data["api.json"]',
  directory: "dashboards",
  text,
  document: embeddedDocument(text),
  labels: { grafana_dashboard: "1" },
});

describe("dashboard JSON embedded in another lexicon's resource (#2962)", () => {
  test("the plugin registers the importer", () => {
    expect(grafanaPlugin.embeddedImporters?.()).toEqual([dashboardImporter, operatorImporter]);
  });

  test("matches classic and v2 dashboard JSON; not other text", () => {
    expect(dashboardImporter.matches(site(DASHBOARD))).toBe(true);
    const v2 = JSON.stringify({ apiVersion: "dashboard.grafana.app/v2beta1", kind: "Dashboard", spec: { elements: {}, layout: {} } });
    expect(dashboardImporter.matches(site(v2))).toBe(true);
    expect(dashboardImporter.matches(site("apiVersion: 1\ndatasources: []\n"))).toBe(false);
  });

  test("keeps a v2 dashboard as written, saying why; imports a classic one (#3031)", () => {
    expect(dashboardImporter.keepsAsWritten?.(site(DASHBOARD))).toBeUndefined();
    const resource = JSON.stringify({ apiVersion: "dashboard.grafana.app/v2beta1", kind: "Dashboard", spec: { elements: {}, layout: {} } });
    const bare = JSON.stringify({ title: "API", elements: {}, layout: { kind: "GridLayout", spec: { items: [] } } });
    for (const v2 of [resource, bare]) {
      const reason = dashboardImporter.keepsAsWritten?.(site(v2));
      expect(reason).toContain("v2 dashboard");
      expect(reason).toContain("classic (v1) dashboard JSON");
      expect(reason).toContain("stays a string");
    }
  });

  test("imports the dashboard into the content's own directory, referenced through dashboardJson", () => {
    const out = dashboardImporter.import(site(DASHBOARD));
    // No second directory inside the one core gives it.
    expect(out.files.every((f) => !f.path.includes("/"))).toBe(true);
    expect(out.value.shape).toBe("single");
    expect(out.value.through).toEqual({ from: "@intentius/chant-lexicon-grafana", name: "dashboardJson" });
    const [binding] = out.value.bindings;
    const file = out.files.find((f) => f.path === binding.from);
    expect(file?.content).toContain(`const ${binding.name} = new Dashboard(`);
  });

  test("panels and queries are written inline, as `chant import dashboard.json` writes them (#3184)", () => {
    const out = dashboardImporter.import(site(DASHBOARD));
    const text = out.files.map((f) => f.content).join("\n");
    expect(text).toContain("new StatPanel(");
    expect(text).not.toMatch(/const panel\d* = new StatPanel/);
  });
});
