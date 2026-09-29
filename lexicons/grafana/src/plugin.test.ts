import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { grafanaPlugin } from "./plugin";
import { grafanaAuditCatalog } from "./lint/audit-catalog";

describe("grafana plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(grafanaPlugin)).toBe(true);
  });

  it("is named grafana and serializes under the GRAF prefix", () => {
    expect(grafanaPlugin.name).toBe("grafana");
    expect(grafanaPlugin.serializer.name).toBe("grafana");
    expect(grafanaPlugin.serializer.rulePrefix).toBe("GRAF");
  });

  it("ships lint rules and post-synth checks, all under the GRAF prefix", () => {
    const ids = [...grafanaPlugin.lintRules!().map((r) => r.id), ...grafanaPlugin.postSynthChecks!().map((c) => c.id)];
    expect(ids).toEqual(["GRAF001", "GRAF002", "GRAF101", "GRAF102", "GRAF103", "GRAF104", "GRAF105", "GRAF106", "GRAF107", "GRAF108", "GRAF110", "GRAF115"]);
  });

  it("catalogues every rule and check for chant audit, and nothing else", () => {
    const ids = [...grafanaPlugin.lintRules!().map((r) => r.id), ...grafanaPlugin.postSynthChecks!().map((c) => c.id)];
    expect(Object.keys(grafanaAuditCatalog).sort()).toEqual([...ids].sort());
    for (const check of grafanaPlugin.postSynthChecks!()) expect(grafanaAuditCatalog[check.id].yamlBased).toBe(true);
  });

  it("detects dashboards and provisioning files and nothing else", () => {
    expect(grafanaPlugin.detectTemplate!({ panels: [], schemaVersion: 41, title: "x" })).toBe(true);
    expect(grafanaPlugin.detectTemplate!({ apiVersion: 1, datasources: [] })).toBe(true);
    expect(grafanaPlugin.detectTemplate!({ apiVersion: 1, providers: [] })).toBe(true);
    expect(grafanaPlugin.detectTemplate!({ apiVersion: "v1", kind: "ConfigMap" })).toBe(false);
    expect(grafanaPlugin.detectTemplate!({ receivers: {}, service: { pipelines: {} } })).toBe(false);
  });

  it("loads its skills with content", () => {
    const skills = grafanaPlugin.skills!();
    expect(skills.map((s) => s.name)).toEqual(["chant-grafana", "chant-grafana-provisioning"]);
    for (const s of skills) expect(s.content.length).toBeGreaterThan(200);
  });

  it("registers namespaced MCP contributions", async () => {
    expect(grafanaPlugin.mcpTools!().map((t) => t.name)).toEqual(["grafana:diff"]);
    const [resource] = grafanaPlugin.mcpResources!();
    expect(resource.uri).toBe("grafana:resource-catalog");
    const body = JSON.parse(await resource.handler());
    expect(body.pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.entities.map((e: { className: string }) => e.className)).toContain("TimeSeriesPanel");
  });
});
