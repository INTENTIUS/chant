import { describe, test, expect } from "bun:test";
import { helmPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("helmPlugin", () => {
  test("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(helmPlugin)).toBe(true);
  });

  test("has name 'helm'", () => {
    expect(helmPlugin.name).toBe("helm");
  });

  test("serializer has name 'helm' and rulePrefix 'WHM'", () => {
    expect(helmPlugin.serializer.name).toBe("helm");
    expect(helmPlugin.serializer.rulePrefix).toBe("WHM");
  });

  test("provides intrinsics", () => {
    const intrinsics = helmPlugin.intrinsics!();
    expect(intrinsics.length).toBeGreaterThan(0);
    const names = intrinsics.map((i) => i.name);
    expect(names).toContain("values");
    expect(names).toContain("Release");
    expect(names).toContain("include");
    expect(names).toContain("If");
  });

  test("provides lint rules", () => {
    const rules = helmPlugin.lintRules!();
    expect(rules.length).toBe(3);
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("WHM001");
    expect(ids).toContain("WHM002");
    expect(ids).toContain("WHM003");
  });

  test("provides post-synth checks", () => {
    const checks = helmPlugin.postSynthChecks!();
    expect(checks.length).toBe(11);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain("WHM101");
    expect(ids).toContain("WHM105");
    expect(ids).toContain("WHM301");
  });

  test("detectTemplate identifies Chart.yaml data", () => {
    expect(helmPlugin.detectTemplate!({ apiVersion: "v2", name: "test", version: "0.1.0" })).toBe(true);
    expect(helmPlugin.detectTemplate!({ apiVersion: "v1", name: "test", version: "0.1.0" })).toBe(false);
    expect(helmPlugin.detectTemplate!({ kind: "Deployment" })).toBe(false);
    expect(helmPlugin.detectTemplate!(null)).toBe(false);
  });

  test("initTemplates returns chart.ts scaffold", () => {
    const templates = helmPlugin.initTemplates!();
    expect(templates.src["chart.ts"]).toBeDefined();
    expect(templates.src["chart.ts"]).toContain("new Chart");
    expect(templates.src["chart.ts"]).toContain("new Values");
    expect(templates.src["chart.ts"]).toContain("new Deployment");
  });

  test("skills() returns array with chant-helm skill", () => {
    const skills = helmPlugin.skills!();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].name).toBe("chant-helm");
    expect(skills[0].content).toContain("Helm Chart Operational Playbook");
  });
});
