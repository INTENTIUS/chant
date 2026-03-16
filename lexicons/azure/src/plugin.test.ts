import { describe, test, expect } from "bun:test";
import { azurePlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("azurePlugin", () => {
  // -----------------------------------------------------------------------
  // Basic interface
  // -----------------------------------------------------------------------

  test("satisfies isLexiconPlugin type guard", () => {
    expect(isLexiconPlugin(azurePlugin)).toBe(true);
  });

  test("has correct name and serializer", () => {
    expect(azurePlugin.name).toBe("azure");
    expect(azurePlugin.serializer.name).toBe("azure");
    expect(azurePlugin.serializer.rulePrefix).toBe("AZR");
  });

  // -----------------------------------------------------------------------
  // Lint rules
  // -----------------------------------------------------------------------

  test("returns lint rules", () => {
    const rules = azurePlugin.lintRules!();
    expect(rules).toHaveLength(3);
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("AZR001");
    expect(ids).toContain("AZR002");
    expect(ids).toContain("AZR003");
  });

  // -----------------------------------------------------------------------
  // Intrinsics / pseudo-parameters
  // -----------------------------------------------------------------------

  test("returns intrinsics", () => {
    const intrinsics = azurePlugin.intrinsics!();
    expect(intrinsics.length).toBe(9);
    const names = intrinsics.map((i) => i.name);
    expect(names).toContain("ResourceId");
    expect(names).toContain("Reference");
    expect(names).toContain("Concat");
  });

  test("returns pseudo-parameters", () => {
    const params = azurePlugin.pseudoParameters!();
    expect(params).toContain("Azure.ResourceGroupName");
    expect(params).toContain("Azure.ResourceGroupLocation");
    expect(params).toContain("Azure.SubscriptionId");
  });

  // -----------------------------------------------------------------------
  // Template detection
  // -----------------------------------------------------------------------

  test("detects ARM templates", () => {
    const armTemplate = JSON.stringify({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [],
    });

    expect(azurePlugin.detectTemplate!(armTemplate)).toBe(true);
  });

  test("rejects non-ARM templates", () => {
    expect(azurePlugin.detectTemplate!("{}")).toBe(false);
    expect(azurePlugin.detectTemplate!("not json")).toBe(false);
    expect(azurePlugin.detectTemplate!(JSON.stringify({ Resources: {} }))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Template parsing / generation
  // -----------------------------------------------------------------------

  test("returns a template parser", () => {
    const parser = azurePlugin.templateParser!();
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  test("returns a template generator", () => {
    const generator = azurePlugin.templateGenerator!();
    expect(generator).toBeDefined();
    expect(typeof generator.generate).toBe("function");
  });

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  describe("skills", () => {
    test("returns at least one skill", () => {
      const skills = azurePlugin.skills!();
      expect(skills.length).toBeGreaterThanOrEqual(1);
    });

    test("chant-azure skill has required fields", () => {
      const skills = azurePlugin.skills!();
      const azureSkill = skills.find((s) => s.name === "chant-azure");
      expect(azureSkill).toBeDefined();
      expect(azureSkill!.description.length).toBeGreaterThan(0);
      expect(azureSkill!.content.length).toBeGreaterThan(0);
    });

    test("chant-azure skill has triggers", () => {
      const skills = azurePlugin.skills!();
      const azureSkill = skills.find((s) => s.name === "chant-azure")!;
      expect(azureSkill.triggers).toBeDefined();
      expect(azureSkill.triggers!.length).toBeGreaterThanOrEqual(1);

      const filePatternTrigger = azureSkill.triggers!.find((t) => t.type === "file_pattern");
      expect(filePatternTrigger).toBeDefined();
      expect(filePatternTrigger!.pattern).toContain("*.azure.ts");
    });

    test("chant-azure skill has parameters", () => {
      const skills = azurePlugin.skills!();
      const azureSkill = skills.find((s) => s.name === "chant-azure")!;
      expect(azureSkill.parameters).toBeDefined();
      expect(azureSkill.parameters!.length).toBeGreaterThanOrEqual(1);

      const resourceTypeParam = azureSkill.parameters!.find((p) => p.name === "resourceType");
      expect(resourceTypeParam).toBeDefined();
      expect(resourceTypeParam!.description.length).toBeGreaterThan(0);
      expect(resourceTypeParam!.type).toBe("string");
    });

    test("chant-azure skill has examples", () => {
      const skills = azurePlugin.skills!();
      const azureSkill = skills.find((s) => s.name === "chant-azure")!;
      expect(azureSkill.examples).toBeDefined();
      expect(azureSkill.examples!.length).toBeGreaterThanOrEqual(1);

      const example = azureSkill.examples![0];
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.output).toBeDefined();
      expect(example.output!).toContain("StorageAccount");
    });
  });

  // -----------------------------------------------------------------------
  // Init templates
  // -----------------------------------------------------------------------

  test("returns init templates", () => {
    const templates = azurePlugin.initTemplates!();
    expect(templates.src).toBeDefined();
    expect(templates.src["main.ts"]).toContain("StorageAccount");
    expect(templates.src["tags.ts"]).toContain("defaultTags");
  });

  // -----------------------------------------------------------------------
  // Required lifecycle methods
  // -----------------------------------------------------------------------

  describe("lifecycle methods", () => {
    test("generate is a function", () => {
      expect(typeof azurePlugin.generate).toBe("function");
    });

    test("validate is a function", () => {
      expect(typeof azurePlugin.validate).toBe("function");
    });

    test("coverage is a function", () => {
      expect(typeof azurePlugin.coverage).toBe("function");
    });

    test("package is a function", () => {
      expect(typeof azurePlugin.package).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // MCP tools
  // -----------------------------------------------------------------------

  describe("mcpTools", () => {
    test("returns at least one tool", () => {
      const tools = azurePlugin.mcpTools!();
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    test("lookup-resource tool has correct structure", () => {
      const tools = azurePlugin.mcpTools!();
      const lookupTool = tools.find((t) => t.name === "lookup-resource");
      expect(lookupTool).toBeDefined();
      expect(lookupTool!.description.length).toBeGreaterThan(0);
      expect(lookupTool!.inputSchema.type).toBe("object");
      expect(lookupTool!.inputSchema.properties.query).toBeDefined();
      expect(typeof lookupTool!.handler).toBe("function");
    });

    test("lookup-resource tool schema has query as required", () => {
      const tools = azurePlugin.mcpTools!();
      const lookupTool = tools.find((t) => t.name === "lookup-resource")!;
      expect(lookupTool.inputSchema.required).toContain("query");
    });
  });

  // -----------------------------------------------------------------------
  // MCP resources
  // -----------------------------------------------------------------------

  describe("mcpResources", () => {
    test("returns at least one resource", () => {
      const resources = azurePlugin.mcpResources!();
      expect(resources.length).toBeGreaterThanOrEqual(1);
    });

    test("catalog has correct structure", () => {
      const resources = azurePlugin.mcpResources!();
      const catalog = resources.find((r) => r.uri === "chant://lexicon/azure/catalog");
      expect(catalog).toBeDefined();
      expect(catalog!.name.length).toBeGreaterThan(0);
      expect(catalog!.description.length).toBeGreaterThan(0);
      expect(catalog!.mimeType).toBe("application/json");
      expect(typeof catalog!.handler).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // Post-synth checks
  // -----------------------------------------------------------------------

  test("returns post-synth checks", () => {
    const checks = azurePlugin.postSynthChecks!();
    expect(checks.length).toBeGreaterThanOrEqual(1);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain("AZR010");
    expect(ids).toContain("AZR011");
  });
});
