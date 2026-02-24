import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { k8sPlugin } from "./plugin";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const hasGenerated = existsSync(
  join(pkgDir, "src", "generated", "lexicon-k8s.json"),
);

describe("k8sPlugin", () => {
  test("name is k8s", () => {
    expect(k8sPlugin.name).toBe("k8s");
  });

  test("serializer is k8sSerializer", () => {
    expect(k8sPlugin.serializer).toBeDefined();
    expect(k8sPlugin.serializer.name).toBe("k8s");
  });

  test("serializer rulePrefix is WK8", () => {
    expect(k8sPlugin.serializer.rulePrefix).toBe("WK8");
  });

  test("lintRules() returns array with WK8001", () => {
    const rules = k8sPlugin.lintRules!();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some((r) => r.id === "WK8001")).toBe(true);
  });

  test("postSynthChecks() returns array of 20 checks", () => {
    const checks = k8sPlugin.postSynthChecks!();
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBe(20);
  });

  test("intrinsics() returns empty array", () => {
    const intrinsics = k8sPlugin.intrinsics!();
    expect(intrinsics).toEqual([]);
  });

  test("initTemplates() returns default template with infra.ts", () => {
    const templates = k8sPlugin.initTemplates!();
    expect(templates.src).toBeDefined();
    expect(templates.src["infra.ts"]).toBeDefined();
    expect(templates.src["infra.ts"]).toContain("Deployment");
    expect(templates.src["infra.ts"]).toContain("Service");
  });

  test("initTemplates('microservice') includes HPA and PDB", () => {
    const templates = k8sPlugin.initTemplates!("microservice");
    expect(templates.src["infra.ts"]).toContain("HorizontalPodAutoscaler");
    expect(templates.src["infra.ts"]).toContain("PodDisruptionBudget");
  });

  test("initTemplates('stateful') includes StatefulSet", () => {
    const templates = k8sPlugin.initTemplates!("stateful");
    expect(templates.src["infra.ts"]).toContain("StatefulSet");
    expect(templates.src["infra.ts"]).toContain('clusterIP: "None"');
  });

  test("detectTemplate() recognizes K8s YAML by apiVersion/kind", () => {
    expect(k8sPlugin.detectTemplate!({ apiVersion: "apps/v1", kind: "Deployment" })).toBe(true);
    expect(k8sPlugin.detectTemplate!({ apiVersion: "v1", kind: "Service" })).toBe(true);
  });

  test("detectTemplate() rejects non-K8s data", () => {
    expect(k8sPlugin.detectTemplate!({})).toBe(false);
    expect(k8sPlugin.detectTemplate!(null)).toBe(false);
    expect(k8sPlugin.detectTemplate!({ stages: [] })).toBe(false);
  });

  test("skills() returns array with chant-k8s skill", () => {
    const skills = k8sPlugin.skills!();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].name).toBe("chant-k8s");
    expect(skills[0].content).toContain("Kubernetes Operational Playbook");
  });

  test.skipIf(!hasGenerated)("completionProvider() returns a function result", () => {
    // Calling with minimal context should not throw
    const result = k8sPlugin.completionProvider!({
      prefix: "",
      line: "",
      position: { line: 0, character: 0 },
      triggerKind: 1,
    } as any);
    expect(result).toBeDefined();
  });

  test.skipIf(!hasGenerated)("hoverProvider() returns function result", () => {
    const result = k8sPlugin.hoverProvider!({
      word: "Deployment",
      position: { line: 0, character: 0 },
    } as any);
    // May return undefined if no generated files exist
    expect(result !== null).toBe(true);
  });

  test("templateParser() returns K8sParser", () => {
    const parser = k8sPlugin.templateParser!();
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  test("templateGenerator() returns K8sGenerator", () => {
    const generator = k8sPlugin.templateGenerator!();
    expect(generator).toBeDefined();
    expect(typeof generator.generate).toBe("function");
  });

  test("mcpTools() returns diff tool", () => {
    const tools = k8sPlugin.mcpTools!();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.some((t) => t.name === "diff")).toBe(true);
  });

  test("mcpResources() returns resource-catalog and examples", () => {
    const resources = k8sPlugin.mcpResources!();
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.some((r) => r.uri === "resource-catalog")).toBe(true);
    expect(resources.some((r) => r.uri === "examples/basic-deployment")).toBe(true);
  });

  test("docs() method exists", () => {
    expect(typeof k8sPlugin.docs).toBe("function");
  });

  test("generate() method exists", () => {
    expect(typeof k8sPlugin.generate).toBe("function");
  });

  test("validate() method exists", () => {
    expect(typeof k8sPlugin.validate).toBe("function");
  });

  test("coverage() method exists", () => {
    expect(typeof k8sPlugin.coverage).toBe("function");
  });

  test("package() method exists", () => {
    expect(typeof k8sPlugin.package).toBe("function");
  });
});
