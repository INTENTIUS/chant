import { describe, test, expect } from "vitest";
import { buildRuleRegistry } from "./rule-registry";
import type { LintRule, LintContext, LintDiagnostic } from "./rule";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "./post-synth";

function mockRule(id: string, overrides: Partial<LintRule> = {}): LintRule {
  return {
    id,
    severity: "warning",
    category: "correctness",
    description: `Description for ${id}`,
    check: (): LintDiagnostic[] => [],
    ...overrides,
  };
}

function mockCheck(id: string, description: string): PostSynthCheck {
  return {
    id,
    description,
    check: (): PostSynthDiagnostic[] => [],
  };
}

describe("buildRuleRegistry", () => {
  test("collects core rules", () => {
    const entries = buildRuleRegistry([
      mockRule("COR001"),
      mockRule("COR008"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("COR001");
    expect(entries[0].source).toBe("core");
    expect(entries[0].phase).toBe("pre-synth");
    expect(entries[0].description).toBe("Description for COR001");
  });

  test("collects plugin lint rules", () => {
    const entries = buildRuleRegistry([], [
      {
        name: "aws",
        rules: [mockRule("WAW001", { category: "security" })],
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("aws");
    expect(entries[0].category).toBe("security");
  });

  test("collects plugin post-synth checks", () => {
    const entries = buildRuleRegistry([], [
      {
        name: "aws",
        postSynthChecks: [
          mockCheck("WAW018", "S3 public access not blocked"),
        ],
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].phase).toBe("post-synth");
    expect(entries[0].hasAutoFix).toBe(false);
    expect(entries[0].category).toBe("security");
  });

  test("sorts entries by ID", () => {
    const entries = buildRuleRegistry([
      mockRule("COR008"),
      mockRule("COR001"),
    ]);

    expect(entries[0].id).toBe("COR001");
    expect(entries[1].id).toBe("COR008");
  });

  test("detects auto-fix capability", () => {
    const withFix = mockRule("COR001");
    withFix.fix = () => [];
    const withoutFix = mockRule("COR002");

    const entries = buildRuleRegistry([withFix, withoutFix]);

    expect(entries.find((e) => e.id === "COR001")?.hasAutoFix).toBe(true);
    expect(entries.find((e) => e.id === "COR002")?.hasAutoFix).toBe(false);
  });

  test("falls back to rule ID when description is missing", () => {
    const rule = mockRule("COR001");
    delete (rule as unknown as Record<string, unknown>).description;

    const entries = buildRuleRegistry([rule]);
    expect(entries[0].description).toBe("COR001");
  });

  test("combines core and plugin rules", () => {
    const entries = buildRuleRegistry(
      [mockRule("COR001")],
      [
        {
          name: "aws",
          rules: [mockRule("WAW001")],
          postSynthChecks: [mockCheck("WAW010", "Redundant DependsOn")],
        },
      ],
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.id)).toEqual(["COR001", "WAW001", "WAW010"]);
  });
});
