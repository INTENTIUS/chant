import { describe, test, expect } from "vitest";
import { dockerPlugin } from "./plugin";

describe("dockerPlugin", () => {
  test("has correct name", () => {
    expect(dockerPlugin.name).toBe("docker");
  });

  test("has serializer", () => {
    expect(dockerPlugin.serializer).toBeDefined();
    expect(dockerPlugin.serializer.name).toBe("docker");
  });

  test("provides lint rules", () => {
    const rules = dockerPlugin.lintRules!();
    expect(rules.length).toBeGreaterThanOrEqual(1);

    const ruleIds = rules.map((r) => r.id);
    expect(ruleIds).toContain("DKRS001");
  });

  test("provides post-synth checks", () => {
    const checks = dockerPlugin.postSynthChecks!();
    expect(checks.length).toBeGreaterThanOrEqual(1);

    const checkIds = checks.map((c) => c.id);
    expect(checkIds).toContain("DKRD001");
    expect(checkIds).toContain("DKRD002");
    expect(checkIds).toContain("DKRD003");
    expect(checkIds).toContain("DKRD010");
    expect(checkIds).toContain("DKRD011");
    expect(checkIds).toContain("DKRD012");
  });

  test("provides intrinsics", () => {
    const intrinsics = dockerPlugin.intrinsics!();
    expect(intrinsics.length).toBe(1);
    expect(intrinsics[0].name).toBe("env");
  });

  test("provides init templates — default", () => {
    const template = dockerPlugin.initTemplates!();
    expect(template.src).toBeDefined();
    expect(template.src["compose.ts"]).toContain("Service");
  });

  test("provides init templates — webapp", () => {
    const template = dockerPlugin.initTemplates!("webapp");
    expect(template.src["compose.ts"]).toContain("postgres");
  });

  test("detects Docker Compose template", () => {
    expect(dockerPlugin.detectTemplate!({ services: {}, volumes: {} })).toBe(true);
  });

  test("rejects non-Docker data", () => {
    expect(dockerPlugin.detectTemplate!({ jobs: {}, on: {} })).toBe(false);
    expect(dockerPlugin.detectTemplate!(null)).toBe(false);
  });

  test("has completionProvider", () => {
    expect(dockerPlugin.completionProvider).toBeDefined();
  });

  test("has hoverProvider", () => {
    expect(dockerPlugin.hoverProvider).toBeDefined();
  });

  test("has templateParser", () => {
    expect(dockerPlugin.templateParser).toBeDefined();
  });

  test("has templateGenerator", () => {
    expect(dockerPlugin.templateGenerator).toBeDefined();
  });

  test("has generate method", () => {
    expect(dockerPlugin.generate).toBeDefined();
  });

  test("has validate method", () => {
    expect(dockerPlugin.validate).toBeDefined();
  });

  test("has coverage method", () => {
    expect(dockerPlugin.coverage).toBeDefined();
  });

  test("has package method", () => {
    expect(dockerPlugin.package).toBeDefined();
  });

  test("has docs method", () => {
    expect(dockerPlugin.docs).toBeDefined();
  });

  test("provides skills", () => {
    const skills = dockerPlugin.skills!();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    const names = skills.map((s) => s.name);
    expect(names).toContain("chant-docker");
    expect(names).toContain("chant-docker-patterns");
  });

  test("provides MCP tools", () => {
    const tools = dockerPlugin.mcpTools!();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("diff");
  });

  test("provides MCP resources", () => {
    const resources = dockerPlugin.mcpResources!();
    expect(resources.length).toBe(2);
    expect(resources[0].uri).toBe("resource-catalog");
    expect(resources[1].uri).toBe("examples/basic-app");
  });
});
