import { describe, test, expect } from "bun:test";
import { githubPlugin } from "./plugin";

describe("githubPlugin", () => {
  test("has correct name", () => {
    expect(githubPlugin.name).toBe("github");
  });

  test("has serializer", () => {
    expect(githubPlugin.serializer).toBeDefined();
    expect(githubPlugin.serializer.name).toBe("github");
  });

  test("provides lint rules", () => {
    const rules = githubPlugin.lintRules!();
    expect(rules.length).toBe(13);

    const ruleIds = rules.map((r) => r.id);
    expect(ruleIds).toContain("GHA001");
    expect(ruleIds).toContain("GHA003");
    expect(ruleIds).toContain("GHA014");
    expect(ruleIds).toContain("GHA020");
  });

  test("provides post-synth checks", () => {
    const checks = githubPlugin.postSynthChecks!();
    expect(checks.length).toBe(6);

    const checkIds = checks.map((c) => c.id);
    expect(checkIds).toContain("GHA006");
    expect(checkIds).toContain("GHA009");
    expect(checkIds).toContain("GHA011");
    expect(checkIds).toContain("GHA017");
    expect(checkIds).toContain("GHA018");
    expect(checkIds).toContain("GHA019");
  });

  test("provides intrinsics", () => {
    const intrinsics = githubPlugin.intrinsics!();
    expect(intrinsics.length).toBe(1);
    expect(intrinsics[0].name).toBe("expression");
  });

  test("provides init templates", () => {
    const defaultTemplate = githubPlugin.initTemplates!();
    expect(defaultTemplate.src).toBeDefined();
    expect(defaultTemplate.src["pipeline.ts"]).toContain("Workflow");
  });

  test("provides node-ci template", () => {
    const template = githubPlugin.initTemplates!("node-ci");
    expect(template.src["pipeline.ts"]).toContain("NodeCI");
  });

  test("provides docker-build template", () => {
    const template = githubPlugin.initTemplates!("docker-build");
    expect(template.src["pipeline.ts"]).toContain("docker");
  });

  test("detects GitHub Actions template", () => {
    expect(githubPlugin.detectTemplate!({ on: {}, jobs: {} })).toBe(true);
  });

  test("detects job-like entries", () => {
    expect(githubPlugin.detectTemplate!({
      build: { "runs-on": "ubuntu-latest", steps: [] },
    })).toBe(true);
  });

  test("rejects non-GitHub Actions data", () => {
    expect(githubPlugin.detectTemplate!({ stages: [], image: "node:20" })).toBe(false);
  });

  test("provides skills", () => {
    const skills = githubPlugin.skills!();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].name).toBe("chant-github");
  });

  test("provides MCP tools", () => {
    const tools = githubPlugin.mcpTools!();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("diff");
  });

  test("provides MCP resources", () => {
    const resources = githubPlugin.mcpResources!();
    expect(resources.length).toBe(2);
    expect(resources[0].uri).toBe("resource-catalog");
    expect(resources[1].uri).toBe("examples/basic-ci");
  });

  test("has completionProvider", () => {
    expect(githubPlugin.completionProvider).toBeDefined();
  });

  test("has hoverProvider", () => {
    expect(githubPlugin.hoverProvider).toBeDefined();
  });

  test("has templateParser", () => {
    expect(githubPlugin.templateParser).toBeDefined();
  });

  test("has templateGenerator", () => {
    expect(githubPlugin.templateGenerator).toBeDefined();
  });

  test("has generate method", () => {
    expect(githubPlugin.generate).toBeDefined();
  });

  test("has validate method", () => {
    expect(githubPlugin.validate).toBeDefined();
  });

  test("has coverage method", () => {
    expect(githubPlugin.coverage).toBeDefined();
  });

  test("has package method", () => {
    expect(githubPlugin.package).toBeDefined();
  });

  test("has docs method", () => {
    expect(githubPlugin.docs).toBeDefined();
  });
});
