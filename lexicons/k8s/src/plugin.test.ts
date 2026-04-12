import { describe, test, expect } from "vitest";
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

  test("postSynthChecks() returns array of post-synth checks", () => {
    const checks = k8sPlugin.postSynthChecks!();
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBe(26);
  });

  test("intrinsics() returns empty array", () => {
    const intrinsics = k8sPlugin.intrinsics!();
    expect(intrinsics).toEqual([]);
  });

  describe("initTemplates", () => {
    const templateCases = [
      {
        id: undefined,
        label: "default",
        expectedConstructors: ["new Deployment", "new Service"],
        unexpectedConstructors: ["new StatefulSet", "new HorizontalPodAutoscaler"],
      },
      {
        id: "microservice",
        label: "microservice",
        expectedConstructors: [
          "new Deployment",
          "new Service",
          "new HorizontalPodAutoscaler",
          "new PodDisruptionBudget",
        ],
        unexpectedConstructors: ["new StatefulSet"],
      },
      {
        id: "stateful",
        label: "stateful",
        expectedConstructors: ["new StatefulSet", "new Service"],
        unexpectedConstructors: ["new Deployment", "new HorizontalPodAutoscaler"],
      },
    ] as const;

    for (const tc of templateCases) {
      describe(`${tc.label} template`, () => {
        test("returns src with non-empty infra.ts", () => {
          const result = k8sPlugin.initTemplates!(tc.id);
          expect(result.src).toBeDefined();
          expect(typeof result.src["infra.ts"]).toBe("string");
          expect(result.src["infra.ts"].length).toBeGreaterThan(0);
        });

        test("contains expected resource constructors", () => {
          const src = k8sPlugin.initTemplates!(tc.id).src["infra.ts"];
          for (const ctor of tc.expectedConstructors) {
            expect(src).toContain(ctor);
          }
        });

        test("does not contain unrelated constructors", () => {
          const src = k8sPlugin.initTemplates!(tc.id).src["infra.ts"];
          for (const ctor of tc.unexpectedConstructors) {
            expect(src).not.toContain(ctor);
          }
        });

        test("has balanced braces and parentheses", () => {
          const src = k8sPlugin.initTemplates!(tc.id).src["infra.ts"];
          let braces = 0;
          let parens = 0;
          for (const ch of src) {
            if (ch === "{") braces++;
            else if (ch === "}") braces--;
            else if (ch === "(") parens++;
            else if (ch === ")") parens--;
          }
          expect(braces).toBe(0);
          expect(parens).toBe(0);
        });

        test("has valid import statement", () => {
          const src = k8sPlugin.initTemplates!(tc.id).src["infra.ts"];
          expect(src).toMatch(/^import \{[^}]+\} from "@intentius\/chant-lexicon-k8s"/);
        });

        test("has at least one export", () => {
          const src = k8sPlugin.initTemplates!(tc.id).src["infra.ts"];
          expect(src).toContain("export const ");
        });
      });
    }

    test("stateful template uses headless service", () => {
      const src = k8sPlugin.initTemplates!("stateful").src["infra.ts"];
      expect(src).toContain('clusterIP: "None"');
    });
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
