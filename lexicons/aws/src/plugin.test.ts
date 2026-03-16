import { describe, test, expect } from "bun:test";
import { awsPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("awsPlugin", () => {
  // -----------------------------------------------------------------------
  // Basic interface
  // -----------------------------------------------------------------------

  test("satisfies isLexiconPlugin type guard", () => {
    expect(isLexiconPlugin(awsPlugin)).toBe(true);
  });

  test("has correct name and serializer", () => {
    expect(awsPlugin.name).toBe("aws");
    expect(awsPlugin.serializer.name).toBe("aws");
    expect(awsPlugin.serializer.rulePrefix).toBe("WAW");
  });

  // -----------------------------------------------------------------------
  // Lint rules
  // -----------------------------------------------------------------------

  test("returns lint rules", () => {
    const rules = awsPlugin.lintRules!();
    expect(rules).toHaveLength(3);
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("WAW001");
    expect(ids).toContain("WAW006");
    expect(ids).toContain("WAW009");
  });

  // -----------------------------------------------------------------------
  // Intrinsics / pseudo-parameters
  // -----------------------------------------------------------------------

  test("returns intrinsics", () => {
    const intrinsics = awsPlugin.intrinsics!();
    expect(intrinsics.length).toBe(9);
    const names = intrinsics.map((i) => i.name);
    expect(names).toContain("Sub");
    expect(names).toContain("Ref");
    expect(names).toContain("GetAtt");
  });

  test("returns pseudo-parameters", () => {
    const params = awsPlugin.pseudoParameters!();
    expect(params).toContain("AWS::StackName");
    expect(params).toContain("AWS::Region");
    expect(params).toContain("AWS::AccountId");
  });

  // -----------------------------------------------------------------------
  // Template detection
  // -----------------------------------------------------------------------

  test("detects CloudFormation templates", () => {
    expect(
      awsPlugin.detectTemplate!({ AWSTemplateFormatVersion: "2010-09-09" }),
    ).toBe(true);

    expect(
      awsPlugin.detectTemplate!({
        Resources: { MyBucket: { Type: "AWS::S3::Bucket" } },
      }),
    ).toBe(true);

    expect(awsPlugin.detectTemplate!({})).toBe(false);
    expect(awsPlugin.detectTemplate!(null)).toBe(false);
    expect(awsPlugin.detectTemplate!("string")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Template parsing / generation
  // -----------------------------------------------------------------------

  test("returns a template parser", () => {
    const parser = awsPlugin.templateParser!();
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  test("returns a template generator", () => {
    const generator = awsPlugin.templateGenerator!();
    expect(generator).toBeDefined();
    expect(typeof generator.generate).toBe("function");
  });

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  describe("skills", () => {
    test("returns at least one skill", () => {
      const skills = awsPlugin.skills!();
      expect(skills.length).toBeGreaterThanOrEqual(1);
    });

    test("chant-aws skill has required fields", () => {
      const skills = awsPlugin.skills!();
      const cfnSkill = skills.find((s) => s.name === "chant-aws");
      expect(cfnSkill).toBeDefined();
      expect(cfnSkill!.description.length).toBeGreaterThan(0);
      expect(cfnSkill!.content.length).toBeGreaterThan(0);
    });

    test("chant-aws skill has triggers", () => {
      const skills = awsPlugin.skills!();
      const cfnSkill = skills.find((s) => s.name === "chant-aws")!;
      expect(cfnSkill.triggers).toBeDefined();
      expect(cfnSkill.triggers!.length).toBeGreaterThanOrEqual(1);

      const filePatternTrigger = cfnSkill.triggers!.find((t) => t.type === "file-pattern");
      expect(filePatternTrigger).toBeDefined();
      expect(filePatternTrigger!.value).toContain("*.aws.ts");

      const contextTrigger = cfnSkill.triggers!.find((t) => t.type === "context");
      expect(contextTrigger).toBeDefined();
      expect(contextTrigger!.value).toBe("aws");
    });

    test("chant-aws skill has parameters", () => {
      const skills = awsPlugin.skills!();
      const cfnSkill = skills.find((s) => s.name === "chant-aws")!;
      expect(cfnSkill.parameters).toBeDefined();
      expect(cfnSkill.parameters!.length).toBeGreaterThanOrEqual(1);

      const resourceTypeParam = cfnSkill.parameters!.find((p) => p.name === "resourceType");
      expect(resourceTypeParam).toBeDefined();
      expect(resourceTypeParam!.description.length).toBeGreaterThan(0);
      expect(resourceTypeParam!.type).toBe("string");
    });

    test("chant-aws skill has examples", () => {
      const skills = awsPlugin.skills!();
      const cfnSkill = skills.find((s) => s.name === "chant-aws")!;
      expect(cfnSkill.examples).toBeDefined();
      expect(cfnSkill.examples!.length).toBeGreaterThanOrEqual(1);

      const s3Example = cfnSkill.examples![0];
      expect(s3Example.title.length).toBeGreaterThan(0);
      expect(s3Example.output).toBeDefined();
      expect(s3Example.output!).toContain("Bucket");
    });

    test("skill content is valid markdown with frontmatter", () => {
      const skills = awsPlugin.skills!();
      const cfnSkill = skills.find((s) => s.name === "chant-aws")!;
      expect(cfnSkill.content).toContain("---");
      expect(cfnSkill.content).toContain("skill: chant-aws");
      expect(cfnSkill.content).toContain("user-invocable: true");
      expect(cfnSkill.content).toContain("chant build");
      expect(cfnSkill.content).toContain("aws cloudformation deploy");
    });
  });

  // -----------------------------------------------------------------------
  // Required lifecycle methods
  // -----------------------------------------------------------------------

  describe("lifecycle methods", () => {
    test("generate is a function", () => {
      expect(typeof awsPlugin.generate).toBe("function");
    });

    test("validate is a function", () => {
      expect(typeof awsPlugin.validate).toBe("function");
    });

    test("coverage is a function", () => {
      expect(typeof awsPlugin.coverage).toBe("function");
    });

    test("package is a function", () => {
      expect(typeof awsPlugin.package).toBe("function");
    });

  });

  // -----------------------------------------------------------------------
  // MCP tools
  // -----------------------------------------------------------------------

  describe("mcpTools", () => {
    test("returns at least one tool", () => {
      const tools = awsPlugin.mcpTools!();
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    test("diff tool has correct structure", () => {
      const tools = awsPlugin.mcpTools!();
      const diffTool = tools.find((t) => t.name === "diff");
      expect(diffTool).toBeDefined();
      expect(diffTool!.description.length).toBeGreaterThan(0);
      expect(diffTool!.inputSchema.type).toBe("object");
      expect(diffTool!.inputSchema.properties.path).toBeDefined();
      expect(typeof diffTool!.handler).toBe("function");
    });

    test("diff tool schema has path as required", () => {
      const tools = awsPlugin.mcpTools!();
      const diffTool = tools.find((t) => t.name === "diff")!;
      expect(diffTool.inputSchema.required).toContain("path");
    });
  });

  // -----------------------------------------------------------------------
  // MCP resources
  // -----------------------------------------------------------------------

  describe("mcpResources", () => {
    test("returns at least one resource", () => {
      const resources = awsPlugin.mcpResources!();
      expect(resources.length).toBeGreaterThanOrEqual(1);
    });

    test("resource-catalog has correct structure", () => {
      const resources = awsPlugin.mcpResources!();
      const catalog = resources.find((r) => r.uri === "resource-catalog");
      expect(catalog).toBeDefined();
      expect(catalog!.name.length).toBeGreaterThan(0);
      expect(catalog!.description.length).toBeGreaterThan(0);
      expect(catalog!.mimeType).toBe("application/json");
      expect(typeof catalog!.handler).toBe("function");
    });

    test("resource-catalog handler returns JSON array of resources", async () => {
      const resources = awsPlugin.mcpResources!();
      const catalog = resources.find((r) => r.uri === "resource-catalog")!;
      const content = await catalog.handler();

      const parsed = JSON.parse(content) as Array<{ className: string; resourceType: string }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(100);

      // Spot-check known resources
      const bucket = parsed.find((r) => r.className === "Bucket");
      expect(bucket).toBeDefined();
      expect(bucket!.resourceType).toBe("AWS::S3::Bucket");

      const table = parsed.find((r) => r.className === "Table");
      expect(table).toBeDefined();
      expect(table!.resourceType).toBe("AWS::DynamoDB::Table");
    });
  });

  // -----------------------------------------------------------------------
  // LSP completionProvider
  // -----------------------------------------------------------------------

  describe("completionProvider", () => {
    test("is defined", () => {
      expect(awsPlugin.completionProvider).toBeDefined();
    });

    test("returns resource completions for new prefix", () => {
      const items = awsPlugin.completionProvider!({
        uri: "file:///a.ts",
        content: "const b = new Bucket",
        position: { line: 0, character: 20 },
        wordAtCursor: "Bucket",
        linePrefix: "const b = new Bucket",
      });
      expect(items.length).toBeGreaterThan(0);
      const bucket = items.find((i) => i.label === "Bucket");
      expect(bucket).toBeDefined();
      expect(bucket!.kind).toBe("resource");
    });

    test("returns empty for non-constructor context", () => {
      const items = awsPlugin.completionProvider!({
        uri: "file:///a.ts",
        content: "const x = 42",
        position: { line: 0, character: 13 },
        wordAtCursor: "42",
        linePrefix: "const x = 42",
      });
      expect(items).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // LSP hoverProvider
  // -----------------------------------------------------------------------

  describe("hoverProvider", () => {
    test("is defined", () => {
      expect(awsPlugin.hoverProvider).toBeDefined();
    });

    test("returns hover info for known resource", () => {
      const info = awsPlugin.hoverProvider!({
        uri: "file:///a.ts",
        content: "new Bucket()",
        position: { line: 0, character: 5 },
        word: "Bucket",
        lineText: "new Bucket()",
      });
      expect(info).toBeDefined();
      expect(info!.contents).toContain("AWS::S3::Bucket");
    });

    test("returns undefined for unknown word", () => {
      const info = awsPlugin.hoverProvider!({
        uri: "file:///a.ts",
        content: "xyz",
        position: { line: 0, character: 1 },
        word: "NotAResource12345",
        lineText: "xyz",
      });
      expect(info).toBeUndefined();
    });
  });
});
