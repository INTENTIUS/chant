import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { flywayPlugin } from "./plugin";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const hasGenerated = existsSync(
  join(pkgDir, "src", "generated", "lexicon-flyway.json"),
);

describe("flywayPlugin", () => {
  test("name is flyway", () => {
    expect(flywayPlugin.name).toBe("flyway");
  });

  test("serializer is defined", () => {
    expect(flywayPlugin.serializer).toBeDefined();
    expect(flywayPlugin.serializer.name).toBe("flyway");
  });

  test("serializer rulePrefix is WFW", () => {
    expect(flywayPlugin.serializer.rulePrefix).toBe("WFW");
  });

  test("lintRules() returns array with WFW001", () => {
    const rules = flywayPlugin.lintRules!();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some((r) => r.id === "WFW001")).toBe(true);
  });

  test("postSynthChecks() returns array of 15 checks", () => {
    const checks = flywayPlugin.postSynthChecks!();
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBe(15);
  });

  test("intrinsics() returns array with resolve, placeholder, env", () => {
    const intrinsics = flywayPlugin.intrinsics!();
    expect(Array.isArray(intrinsics)).toBe(true);
    expect(intrinsics.length).toBe(3);
    expect(intrinsics.some((i) => i.name === "resolve")).toBe(true);
    expect(intrinsics.some((i) => i.name === "placeholder")).toBe(true);
    expect(intrinsics.some((i) => i.name === "env")).toBe(true);
  });

  test("pseudoParameters() returns known flyway placeholders", () => {
    const params = flywayPlugin.pseudoParameters!();
    expect(Array.isArray(params)).toBe(true);
    expect(params.length).toBeGreaterThanOrEqual(1);
    expect(params).toContain("flyway:defaultSchema");
  });

  describe("initTemplates", () => {
    test("default template returns src with config.ts and infra.ts", () => {
      const result = flywayPlugin.initTemplates!();
      expect(result.src).toBeDefined();
      expect(typeof result.src["config.ts"]).toBe("string");
      expect(typeof result.src["infra.ts"]).toBe("string");
    });

    test("default template contains FlywayProject and Environment", () => {
      const src = flywayPlugin.initTemplates!().src["infra.ts"];
      expect(src).toContain("new FlywayProject");
      expect(src).toContain("new Environment");
    });

    test("multi-env template has 4 environments", () => {
      const src = flywayPlugin.initTemplates!("multi-env").src["infra.ts"];
      expect(src).toContain("export const dev");
      expect(src).toContain("export const shadow");
      expect(src).toContain("export const staging");
      expect(src).toContain("export const prod");
    });

    test("vault-secured template has VaultResolver", () => {
      const src = flywayPlugin.initTemplates!("vault-secured").src["infra.ts"];
      expect(src).toContain("new VaultResolver");
      expect(src).toContain("resolve(");
    });

    test("docker-dev template has docker provisioner", () => {
      const src = flywayPlugin.initTemplates!("docker-dev").src["infra.ts"];
      expect(src).toContain('provisioner: "docker"');
    });
  });

  test("detectTemplate() recognizes Flyway TOML data", () => {
    expect(flywayPlugin.detectTemplate!({ flyway: {} })).toBe(true);
    expect(flywayPlugin.detectTemplate!({ environments: {} })).toBe(true);
  });

  test("detectTemplate() rejects non-Flyway data", () => {
    expect(flywayPlugin.detectTemplate!({})).toBe(false);
    expect(flywayPlugin.detectTemplate!(null)).toBe(false);
    expect(flywayPlugin.detectTemplate!({ apiVersion: "v1" })).toBe(false);
  });

  test("skills() returns array with chant-flyway skill", () => {
    const skills = flywayPlugin.skills!();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].name).toBe("chant-flyway");
    expect(skills[0].content).toContain("Flyway Migration Operational Playbook");
  });

  test.skipIf(!hasGenerated)("completionProvider() returns a function result", () => {
    const result = flywayPlugin.completionProvider!({
      prefix: "",
      line: "",
      position: { line: 0, character: 0 },
      triggerKind: 1,
    } as any);
    expect(result).toBeDefined();
  });

  test.skipIf(!hasGenerated)("hoverProvider() returns function result", () => {
    const result = flywayPlugin.hoverProvider!({
      word: "FlywayProject",
      position: { line: 0, character: 0 },
    } as any);
    expect(result !== null).toBe(true);
  });

  test("templateParser() returns FlywayParser", () => {
    const parser = flywayPlugin.templateParser!();
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  test("templateGenerator() returns FlywayGenerator", () => {
    const generator = flywayPlugin.templateGenerator!();
    expect(generator).toBeDefined();
    expect(typeof generator.generate).toBe("function");
  });

  test("mcpTools() returns diff tool", () => {
    const tools = flywayPlugin.mcpTools!();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.some((t) => t.name === "diff")).toBe(true);
  });

  test("mcpResources() returns resource-catalog and examples", () => {
    const resources = flywayPlugin.mcpResources!();
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.some((r) => r.uri === "resource-catalog")).toBe(true);
    expect(resources.some((r) => r.uri === "examples/multi-environment")).toBe(true);
  });

  test("docs() method exists", () => {
    expect(typeof flywayPlugin.docs).toBe("function");
  });

  test("generate() method exists", () => {
    expect(typeof flywayPlugin.generate).toBe("function");
  });

  test("validate() method exists", () => {
    expect(typeof flywayPlugin.validate).toBe("function");
  });

  test("coverage() method exists", () => {
    expect(typeof flywayPlugin.coverage).toBe("function");
  });

  test("package() method exists", () => {
    expect(typeof flywayPlugin.package).toBe("function");
  });
});
