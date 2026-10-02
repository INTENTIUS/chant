import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { resolveParserOptions } from "@intentius/chant/import/parser-options";
import { grafanaPlugin } from "./plugin";
import { LOSSY_V1_EXPORT, read } from "./import/testdata/fixtures";
import { grafanaAuditCatalog } from "./lint/audit-catalog";

describe("grafana plugin", () => {
  it("declares acceptLossyV1 as its parser option and passes it to the parser (#2994)", () => {
    expect(grafanaPlugin.parserOptions!()).toEqual([expect.objectContaining({ name: "acceptLossyV1", type: "boolean" })]);
    const lossy = read(LOSSY_V1_EXPORT);
    expect(grafanaPlugin.templateParser!().parse(lossy).resources).toEqual([]);
    const accepted = grafanaPlugin.templateParser!({ acceptLossyV1: true }).parse(lossy);
    expect(accepted.resources).toHaveLength(1);
    const resolved = resolveParserOptions(grafanaPlugin, ["acceptLossyV1"]);
    expect(resolved).toEqual({ options: { acceptLossyV1: true } });
    expect(resolveParserOptions(grafanaPlugin, ["acceptLossy"])).toHaveProperty("error");
  });

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
    expect(ids).toEqual(["GRAF001", "GRAF002", "GRAF101", "GRAF102", "GRAF103", "GRAF104", "GRAF105", "GRAF106", "GRAF107", "GRAF108", "GRAF109", "GRAF110", "GRAF111", "GRAF112", "GRAF113", "GRAF114", "GRAF115", "GRAF116", "GRAF117"]);
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
    expect(grafanaPlugin.detectTemplate!({ apiVersion: 1, groups: [{ name: "g", folder: "F", rules: [] }] })).toBe(true);
    expect(grafanaPlugin.detectTemplate!({ apiVersion: 1, contactPoints: [] })).toBe(true);
    expect(grafanaPlugin.detectTemplate!({ groups: [{ name: "g", rules: [{ alert: "A", expr: "up == 0" }] }] })).toBe(false);
    expect(grafanaPlugin.detectTemplate!({ apiVersion: "v1", kind: "ConfigMap" })).toBe(false);
    expect(grafanaPlugin.detectTemplate!({ receivers: {}, service: { pipelines: {} } })).toBe(false);
  });

  it("loads its skills with content", () => {
    const skills = grafanaPlugin.skills!();
    expect(skills.map((s) => s.name)).toEqual(["chant-grafana", "chant-grafana-provisioning", "chant-grafana-alerting", "chant-grafana-operations"]);
    for (const s of skills) expect(s.content.length).toBeGreaterThan(200);
  });

  it("offers a default init template and three named ones", () => {
    const names = [undefined, "red", "k8s-pods", "slo"];
    const sets = names.map((n) => grafanaPlugin.initTemplates!(n));
    expect(new Set(sets).size).toBe(4);
    for (const set of sets) expect(Object.keys(set.src).length).toBeGreaterThan(0);
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
