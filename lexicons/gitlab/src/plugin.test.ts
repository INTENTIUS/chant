import { describe, test, expect } from "bun:test";
import { gitlabPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("gitlabPlugin", () => {
  // -----------------------------------------------------------------------
  // Basic interface
  // -----------------------------------------------------------------------

  test("satisfies isLexiconPlugin type guard", () => {
    expect(isLexiconPlugin(gitlabPlugin)).toBe(true);
  });

  test("has correct name and serializer", () => {
    expect(gitlabPlugin.name).toBe("gitlab");
    expect(gitlabPlugin.serializer.name).toBe("gitlab");
    expect(gitlabPlugin.serializer.rulePrefix).toBe("WGL");
  });

  // -----------------------------------------------------------------------
  // Intrinsics
  // -----------------------------------------------------------------------

  test("returns intrinsics", () => {
    const intrinsics = gitlabPlugin.intrinsics!();
    expect(intrinsics).toHaveLength(1);
    expect(intrinsics[0].name).toBe("reference");
    expect(intrinsics[0].outputKey).toBe("!reference");
    expect(intrinsics[0].isTag).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Template detection
  // -----------------------------------------------------------------------

  test("detectTemplate returns true for stages array", () => {
    expect(gitlabPlugin.detectTemplate!({ stages: ["build", "test"] })).toBe(true);
  });

  test("detectTemplate returns true for image + script", () => {
    expect(gitlabPlugin.detectTemplate!({ image: "node:20", script: ["test"] })).toBe(true);
  });

  test("detectTemplate returns true for job-like entries", () => {
    expect(
      gitlabPlugin.detectTemplate!({
        test_job: { stage: "test", script: ["npm test"] },
      }),
    ).toBe(true);
  });

  test("detectTemplate returns false for empty object", () => {
    expect(gitlabPlugin.detectTemplate!({})).toBe(false);
  });

  test("detectTemplate returns false for non-object", () => {
    expect(gitlabPlugin.detectTemplate!("string")).toBe(false);
    expect(gitlabPlugin.detectTemplate!(null)).toBe(false);
    expect(gitlabPlugin.detectTemplate!(42)).toBe(false);
  });

  test("detectTemplate returns false for unrelated object", () => {
    expect(gitlabPlugin.detectTemplate!({ AWSTemplateFormatVersion: "2010-09-09" })).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Lint rules
  // -----------------------------------------------------------------------

  test("returns lint rules", () => {
    const rules = gitlabPlugin.lintRules!();
    expect(rules).toHaveLength(4);
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("WGL001");
    expect(ids).toContain("WGL002");
    expect(ids).toContain("WGL003");
    expect(ids).toContain("WGL004");
  });

  // -----------------------------------------------------------------------
  // Post-synth checks
  // -----------------------------------------------------------------------

  test("returns post-synth checks", () => {
    const checks = gitlabPlugin.postSynthChecks!();
    expect(checks).toHaveLength(6);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain("WGL010");
    expect(ids).toContain("WGL011");
    expect(ids).toContain("WGL012");
    expect(ids).toContain("WGL013");
    expect(ids).toContain("WGL014");
    expect(ids).toContain("WGL015");
  });

  // -----------------------------------------------------------------------
  // Init templates
  // -----------------------------------------------------------------------

  test("returns default init templates with src files", () => {
    const result = gitlabPlugin.initTemplates!();
    expect(result.src).toBeDefined();
    expect(result.src["config.ts"]).toBeDefined();
    expect(result.src["pipeline.ts"]).toBeDefined();
  });

  test("default init templates import from gitlab lexicon", () => {
    const result = gitlabPlugin.initTemplates!();
    expect(result.src["config.ts"]).toContain("@intentius/chant-lexicon-gitlab");
    expect(result.src["pipeline.ts"]).toContain("@intentius/chant-lexicon-gitlab");
  });

  test("node-pipeline template uses NodePipeline composite", () => {
    const result = gitlabPlugin.initTemplates!("node-pipeline");
    expect(result.src["pipeline.ts"]).toContain("NodePipeline");
  });

  test("python-pipeline template uses PythonPipeline composite", () => {
    const result = gitlabPlugin.initTemplates!("python-pipeline");
    expect(result.src["pipeline.ts"]).toContain("PythonPipeline");
  });

  test("docker-build template uses DockerBuild composite", () => {
    const result = gitlabPlugin.initTemplates!("docker-build");
    expect(result.src["pipeline.ts"]).toContain("DockerBuild");
  });

  test("review-app template uses ReviewApp composite", () => {
    const result = gitlabPlugin.initTemplates!("review-app");
    expect(result.src["pipeline.ts"]).toContain("ReviewApp");
  });

  // -----------------------------------------------------------------------
  // LSP
  // -----------------------------------------------------------------------

  test("completionProvider returns results for new prefix", () => {
    const items = gitlabPlugin.completionProvider!({
      uri: "file:///a.ts",
      content: "const j = new Job",
      position: { line: 0, character: 17 },
      wordAtCursor: "Job",
      linePrefix: "const j = new Job",
    });
    expect(items.length).toBeGreaterThan(0);
    const job = items.find((i) => i.label === "Job");
    expect(job).toBeDefined();
    expect(job!.kind).toBe("resource");
  });

  test("hoverProvider returns info for known entity", () => {
    const hover = gitlabPlugin.hoverProvider!({
      uri: "file:///a.ts",
      content: "new Job({})",
      position: { line: 0, character: 4 },
      word: "Job",
      lineText: "new Job({})",
    });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("Job");
  });

  // -----------------------------------------------------------------------
  // Template import
  // -----------------------------------------------------------------------

  test("has templateParser method", () => {
    expect(typeof gitlabPlugin.templateParser).toBe("function");
    const parser = gitlabPlugin.templateParser!();
    expect(typeof parser.parse).toBe("function");
  });

  test("has templateGenerator method", () => {
    expect(typeof gitlabPlugin.templateGenerator).toBe("function");
    const gen = gitlabPlugin.templateGenerator!();
    expect(typeof gen.generate).toBe("function");
  });

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  test("returns skills", () => {
    const skills = gitlabPlugin.skills!();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("chant-gitlab");
    expect(skills[0].description).toBeDefined();
    expect(skills[0].content).toContain("skill: chant-gitlab");
    expect(skills[0].content).toContain("user-invocable: true");
    expect(skills[0].content).toContain("chant build");
    expect(skills[0].content).toContain("chant lint");
    expect(skills[0].triggers).toHaveLength(5);
    expect(skills[0].examples).toHaveLength(5);
    expect(skills[0].preConditions).toHaveLength(3);
    expect(skills[0].postConditions).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // MCP
  // -----------------------------------------------------------------------

  test("returns MCP tools", () => {
    const tools = gitlabPlugin.mcpTools!();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("diff");
    expect(typeof tools[0].handler).toBe("function");
  });

  test("returns MCP resources", () => {
    const resources = gitlabPlugin.mcpResources!();
    expect(resources.length).toBeGreaterThan(0);
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("resource-catalog");
    expect(uris).toContain("examples/basic-pipeline");
  });

  test("MCP resource-catalog handler returns JSON", async () => {
    const resources = gitlabPlugin.mcpResources!();
    const catalog = resources.find((r) => r.uri === "resource-catalog")!;
    const result = await catalog.handler();
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(19);
    const job = parsed.find((e: { className: string }) => e.className === "Job");
    expect(job).toBeDefined();
    expect(job.kind).toBe("resource");
  });

  // -----------------------------------------------------------------------
  // Methods exist
  // -----------------------------------------------------------------------

  test("has generate method", () => {
    expect(typeof gitlabPlugin.generate).toBe("function");
  });

  test("has validate method", () => {
    expect(typeof gitlabPlugin.validate).toBe("function");
  });

  test("has package method", () => {
    expect(typeof gitlabPlugin.package).toBe("function");
  });

  test("has coverage method", () => {
    expect(typeof gitlabPlugin.coverage).toBe("function");
  });

  test("has docs method", () => {
    expect(typeof gitlabPlugin.docs).toBe("function");
  });
});
