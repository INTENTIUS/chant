import { describe, test, expect } from "bun:test";
import { gcpPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("gcpPlugin", () => {
  // ── Basic interface ────────────────────────────────────────────────

  test("satisfies isLexiconPlugin type guard", () => {
    expect(isLexiconPlugin(gcpPlugin)).toBe(true);
  });

  test("has correct name and serializer", () => {
    expect(gcpPlugin.name).toBe("gcp");
    expect(gcpPlugin.serializer.name).toBe("gcp");
    expect(gcpPlugin.serializer.rulePrefix).toBe("WGC");
  });

  // ── Lint rules ─────────────────────────────────────────────────────

  test("returns lint rules", () => {
    const rules = gcpPlugin.lintRules!();
    expect(rules).toHaveLength(3);
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("WGC001");
    expect(ids).toContain("WGC002");
    expect(ids).toContain("WGC003");
  });

  // ── Post-synth checks ─────────────────────────────────────────────

  test("returns post-synth checks", () => {
    const checks = gcpPlugin.postSynthChecks!();
    expect(checks).toHaveLength(20);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain("WGC101");
    expect(ids).toContain("WGC102");
    expect(ids).toContain("WGC103");
    expect(ids).toContain("WGC104");
    expect(ids).toContain("WGC105");
    expect(ids).toContain("WGC106");
    expect(ids).toContain("WGC107");
    expect(ids).toContain("WGC108");
    expect(ids).toContain("WGC109");
    expect(ids).toContain("WGC110");
    expect(ids).toContain("WGC111");
    expect(ids).toContain("WGC112");
    expect(ids).toContain("WGC113");
    expect(ids).toContain("WGC201");
    expect(ids).toContain("WGC202");
    expect(ids).toContain("WGC203");
    expect(ids).toContain("WGC204");
    expect(ids).toContain("WGC301");
    expect(ids).toContain("WGC302");
    expect(ids).toContain("WGC303");
  });

  // ── Intrinsics / pseudo-parameters ─────────────────────────────────

  test("returns no intrinsics (Config Connector has none)", () => {
    const intrinsics = gcpPlugin.intrinsics!();
    expect(intrinsics).toHaveLength(0);
  });

  test("returns pseudo-parameters", () => {
    const params = gcpPlugin.pseudoParameters!();
    expect(params).toContain("GCP::ProjectId");
    expect(params).toContain("GCP::Region");
    expect(params).toContain("GCP::Zone");
  });

  // ── Template detection ─────────────────────────────────────────────

  test("detects Config Connector templates", () => {
    expect(
      gcpPlugin.detectTemplate!({
        apiVersion: "compute.cnrm.cloud.google.com/v1beta1",
        kind: "ComputeInstance",
      }),
    ).toBe(true);

    expect(gcpPlugin.detectTemplate!({})).toBe(false);
    expect(gcpPlugin.detectTemplate!(null)).toBe(false);
  });

  // ── Template parsing / generation ──────────────────────────────────

  test("returns a template parser", () => {
    const parser = gcpPlugin.templateParser!();
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  test("returns a template generator", () => {
    const generator = gcpPlugin.templateGenerator!();
    expect(generator).toBeDefined();
    expect(typeof generator.generate).toBe("function");
  });

  // ── Init templates ─────────────────────────────────────────────────

  test("returns default init template", () => {
    const templates = gcpPlugin.initTemplates!();
    expect(templates.src).toBeDefined();
    expect(templates.src["infra.ts"]).toContain("StorageBucket");
  });

  test("returns GKE init template", () => {
    const templates = gcpPlugin.initTemplates!("gke");
    expect(templates.src).toBeDefined();
    expect(templates.src["infra.ts"]).toContain("GKECluster");
  });

  // ── Skills ─────────────────────────────────────────────────────────

  describe("skills", () => {
    test("returns at least three skills", () => {
      const skills = gcpPlugin.skills!();
      expect(skills.length).toBeGreaterThanOrEqual(3);
    });

    test("chant-gcp skill has required fields", () => {
      const skills = gcpPlugin.skills!();
      const gcpSkill = skills.find((s) => s.name === "chant-gcp");
      expect(gcpSkill).toBeDefined();
      expect(gcpSkill!.description.length).toBeGreaterThan(0);
      expect(gcpSkill!.content.length).toBeGreaterThan(0);
    });

    test("chant-gcp skill has triggers", () => {
      const skills = gcpPlugin.skills!();
      const gcpSkill = skills.find((s) => s.name === "chant-gcp")!;
      expect(gcpSkill.triggers).toBeDefined();
      expect(gcpSkill.triggers!.length).toBeGreaterThanOrEqual(1);

      const filePatternTrigger = gcpSkill.triggers!.find((t) => t.type === "file-pattern");
      expect(filePatternTrigger).toBeDefined();
      expect(filePatternTrigger!.value).toContain("*.gcp.ts");

      const contextTrigger = gcpSkill.triggers!.find((t) => t.type === "context");
      expect(contextTrigger).toBeDefined();
      expect(contextTrigger!.value).toBe("gcp");
    });

    test("chant-gcp skill has parameters", () => {
      const skills = gcpPlugin.skills!();
      const gcpSkill = skills.find((s) => s.name === "chant-gcp")!;
      expect(gcpSkill.parameters).toBeDefined();
      expect(gcpSkill.parameters!.length).toBeGreaterThanOrEqual(1);
    });

    test("chant-gcp skill has examples", () => {
      const skills = gcpPlugin.skills!();
      const gcpSkill = skills.find((s) => s.name === "chant-gcp")!;
      expect(gcpSkill.examples).toBeDefined();
      expect(gcpSkill.examples!.length).toBeGreaterThanOrEqual(1);
    });

    test("skill content is valid markdown with frontmatter", () => {
      const skills = gcpPlugin.skills!();
      const gcpSkill = skills.find((s) => s.name === "chant-gcp")!;
      expect(gcpSkill.content).toContain("---");
      expect(gcpSkill.content).toContain("skill: chant-gcp");
      expect(gcpSkill.content).toContain("user-invocable: true");
      expect(gcpSkill.content).toContain("chant build");
    });

    test("chant-gcp-security skill is present with content", () => {
      const skills = gcpPlugin.skills!();
      const securitySkill = skills.find((s) => s.name === "chant-gcp-security");
      expect(securitySkill).toBeDefined();
      expect(securitySkill!.content.length).toBeGreaterThan(0);
      expect(securitySkill!.content).toContain("Security");
    });

    test("chant-gcp-patterns skill is present with content", () => {
      const skills = gcpPlugin.skills!();
      const patternsSkill = skills.find((s) => s.name === "chant-gcp-patterns");
      expect(patternsSkill).toBeDefined();
      expect(patternsSkill!.content.length).toBeGreaterThan(0);
      expect(patternsSkill!.content).toContain("Composite");
    });
  });

  // ── Lifecycle methods ──────────────────────────────────────────────

  describe("lifecycle methods", () => {
    test("generate is a function", () => {
      expect(typeof gcpPlugin.generate).toBe("function");
    });

    test("validate is a function", () => {
      expect(typeof gcpPlugin.validate).toBe("function");
    });

    test("coverage is a function", () => {
      expect(typeof gcpPlugin.coverage).toBe("function");
    });

    test("package is a function", () => {
      expect(typeof gcpPlugin.package).toBe("function");
    });
  });

  // ── MCP ────────────────────────────────────────────────────────────

  describe("mcpTools", () => {
    test("returns at least one tool", () => {
      const tools = gcpPlugin.mcpTools!();
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    test("diff tool has correct structure", () => {
      const tools = gcpPlugin.mcpTools!();
      const diffTool = tools.find((t) => t.name === "diff");
      expect(diffTool).toBeDefined();
      expect(diffTool!.description.length).toBeGreaterThan(0);
      expect(diffTool!.inputSchema.type).toBe("object");
      expect(typeof diffTool!.handler).toBe("function");
    });
  });

  describe("mcpResources", () => {
    test("returns at least one resource", () => {
      const resources = gcpPlugin.mcpResources!();
      expect(resources.length).toBeGreaterThanOrEqual(1);
    });

    test("resource-catalog has correct structure", () => {
      const resources = gcpPlugin.mcpResources!();
      const catalog = resources.find((r) => r.uri === "resource-catalog");
      expect(catalog).toBeDefined();
      expect(catalog!.mimeType).toBe("application/json");
      expect(typeof catalog!.handler).toBe("function");
    });
  });

  // ── LSP ────────────────────────────────────────────────────────────

  describe("completionProvider", () => {
    test("is defined", () => {
      expect(gcpPlugin.completionProvider).toBeDefined();
    });
  });

  describe("hoverProvider", () => {
    test("is defined", () => {
      expect(gcpPlugin.hoverProvider).toBeDefined();
    });
  });
});
