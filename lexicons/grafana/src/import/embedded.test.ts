import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { grafanaPlugin } from "../plugin";
import { dashboardImporter } from "./embedded";

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
    expect(grafanaPlugin.embeddedImporters?.()).toEqual([dashboardImporter]);
  });

  test("matches classic dashboard JSON; not a v2 dashboard or other text", () => {
    expect(dashboardImporter.matches(site(DASHBOARD))).toBe(true);
    const v2 = JSON.stringify({ apiVersion: "dashboard.grafana.app/v2beta1", kind: "Dashboard", spec: { elements: {}, layout: {} } });
    expect(dashboardImporter.matches(site(v2))).toBe(false);
    expect(dashboardImporter.matches(site("apiVersion: 1\ndatasources: []\n"))).toBe(false);
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
});
