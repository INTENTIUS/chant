import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { prometheusPlugin } from "./plugin";
import { prometheusAuditCatalog } from "./lint/audit-catalog";

describe("prometheus plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(prometheusPlugin)).toBe(true);
  });

  it("is named prometheus and serializes under the PROM prefix", () => {
    expect(prometheusPlugin.name).toBe("prometheus");
    expect(prometheusPlugin.serializer.name).toBe("prometheus");
    expect(prometheusPlugin.serializer.rulePrefix).toBe("PROM");
    expect(prometheusPlugin.serializer.extraRulePrefixes).toBeUndefined();
  });

  it("ships lint rules and post-synth checks, all under the PROM prefix", () => {
    const ids = [...prometheusPlugin.lintRules!().map((r) => r.id), ...prometheusPlugin.postSynthChecks!().map((c) => c.id)];
    expect(ids).toEqual([
      "PROM001",
      "PROM002",
      "PROM003",
      "PROM101",
      "PROM102",
      "PROM103",
      "PROM104",
      "PROM105",
      "PROM106",
      "PROM107",
      "PROM201",
      "PROM202",
      "PROM203",
      "PROM204",
      "PROM205",
      "PROM206",
      "PROM207",
      "PROM208",
      "PROM209",
      "PROM210",
      "PROM211",
      "PROM212",
      "PROM213",
      "PROM214",
      "PROM215",
      "PROM216",
      "PROM217",
      "PROM218",
      "PROM219",
      "PROM220",
      "PROM221",
      "PROM222",
      "PROM223",
      "PROM224",
    ]);
  });

  it("catalogues every rule and post-synth check for chant audit, and nothing else", () => {
    const ids = [...prometheusPlugin.lintRules!().map((r) => r.id), ...prometheusPlugin.postSynthChecks!().map((c) => c.id)];
    expect(Object.keys(prometheusAuditCatalog).sort()).toEqual([...ids].sort());
  });

  it("leaves PROM212 out of the recommended preset, and has it in all (#3363)", () => {
    const presets = prometheusPlugin.lintPresets!();
    expect(presets.all).toContain("PROM212");
    expect(presets.recommended).not.toContain("PROM212");
    expect(presets.all.filter((id) => !presets.recommended.includes(id))).toEqual(["PROM212"]);
  });

  it("detects a rule file and an alertmanager.yml, and nothing else", () => {
    expect(prometheusPlugin.detectTemplate!({ groups: [{ name: "a", rules: [] }] })).toBe(true);
    expect(prometheusPlugin.detectTemplate!({ route: { receiver: "x" }, receivers: [{ name: "x" }] })).toBe(true);
    expect(prometheusPlugin.detectTemplate!({ apiVersion: "v1", kind: "ConfigMap" })).toBe(false);
    expect(prometheusPlugin.detectTemplate!({ receivers: { otlp: {} }, service: { pipelines: {} } })).toBe(false);
    expect(prometheusPlugin.detectTemplate!({ groups: "nope" })).toBe(false);
  });

  it("loads its skills with content", () => {
    const skills = prometheusPlugin.skills!();
    expect(skills.map((s) => s.name)).toEqual(["chant-prometheus", "chant-prometheus-alertmanager", "chant-prometheus-kubernetes"]);
    for (const s of skills) expect(s.content.length).toBeGreaterThan(100);
  });

  it("registers namespaced MCP contributions", () => {
    expect(prometheusPlugin.mcpTools!().map((t) => t.name)).toEqual(["prometheus:diff"]);
    expect(prometheusPlugin.mcpResources!().map((r) => r.uri)).toEqual(["prometheus:resource-catalog"]);
  });

  it("serves the catalog with its pins", async () => {
    const body = JSON.parse(await prometheusPlugin.mcpResources!()[0].handler());
    expect(body.pin.prometheus.version).toBe("v3.15.0");
    expect(body.pin.alertmanager.version).toBe("v0.34.1");
    expect(body.entities.map((e: { className: string }) => e.className)).toContain("RuleGroup");
  });
});
