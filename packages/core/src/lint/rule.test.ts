import { describe, test, expect } from "bun:test";
import type {
  LintRule,
  LintContext,
  LintDiagnostic,
  LintFix,
  Severity,
  Category,
} from "./rule";
import * as ts from "typescript";

describe("LintRule interfaces", () => {
  test("creates mock LintRule with all required methods", () => {
    const mockRule: LintRule = {
      id: "test-rule",
      severity: "warning" as Severity,
      category: "correctness" as Category,
      check: (context: LintContext) => [],
      fix: (context: LintContext) => [],
    };

    expect(mockRule.id).toBe("test-rule");
    expect(mockRule.severity).toBe("warning");
    expect(mockRule.category).toBe("correctness");
    expect(typeof mockRule.check).toBe("function");
    expect(typeof mockRule.fix).toBe("function");
  });

  test("creates LintContext with undefined lexicon for core rules", () => {
    const sourceFile = ts.createSourceFile(
      "test.ts",
      "const x = 1;",
      ts.ScriptTarget.Latest,
      true
    );

    const context: LintContext = {
      sourceFile,
      entities: [],
      filePath: "test.ts",
      lexicon: undefined,
    };

    expect(context.sourceFile).toBe(sourceFile);
    expect(context.entities).toEqual([]);
    expect(context.filePath).toBe("test.ts");
    expect(context.lexicon).toBeUndefined();
  });

  test("creates LintContext with lexicon for lexicon-specific rules", () => {
    const sourceFile = ts.createSourceFile(
      "test.ts",
      "const x = 1;",
      ts.ScriptTarget.Latest,
      true
    );

    const context: LintContext = {
      sourceFile,
      entities: [{ name: "TestEntity" }],
      filePath: "test.ts",
      lexicon: "my-domain",
    };

    expect(context.lexicon).toBe("my-domain");
  });

  test("creates LintDiagnostic without fix", () => {
    const diagnostic: LintDiagnostic = {
      file: "/src/test.ts",
      line: 10,
      column: 5,
      ruleId: "no-unused-vars",
      severity: "error",
      message: "Variable 'x' is declared but never used",
    };

    expect(diagnostic.file).toBe("/src/test.ts");
    expect(diagnostic.line).toBe(10);
    expect(diagnostic.column).toBe(5);
    expect(diagnostic.ruleId).toBe("no-unused-vars");
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.message).toBe("Variable 'x' is declared but never used");
    expect(diagnostic.fix).toBeUndefined();
  });

  test("creates LintDiagnostic with fix", () => {
    const fix: LintFix = {
      range: [100, 110],
      replacement: "const y = 1;",
    };

    const diagnostic: LintDiagnostic = {
      file: "/src/test.ts",
      line: 10,
      column: 5,
      ruleId: "prefer-const",
      severity: "warning",
      message: "Use 'const' instead of 'let'",
      fix,
    };

    expect(diagnostic.fix).toBe(fix);
    expect(diagnostic.fix?.range).toEqual([100, 110]);
    expect(diagnostic.fix?.replacement).toBe("const y = 1;");
  });

  test("LintDiagnostic serializes to JSON correctly", () => {
    const diagnostic: LintDiagnostic = {
      file: "/src/app.ts",
      line: 42,
      column: 15,
      ruleId: "no-console",
      severity: "info",
      message: "Unexpected console statement",
      fix: {
        range: [500, 520],
        replacement: "",
      },
    };

    const json = JSON.parse(JSON.stringify(diagnostic));

    expect(json).toEqual({
      file: "/src/app.ts",
      line: 42,
      column: 15,
      ruleId: "no-console",
      severity: "info",
      message: "Unexpected console statement",
      fix: {
        range: [500, 520],
        replacement: "",
      },
    });
  });

  test("LintFix has valid source positions", () => {
    const fix: LintFix = {
      range: [0, 10],
      replacement: "new code",
    };

    expect(fix.range[0]).toBeGreaterThanOrEqual(0);
    expect(fix.range[1]).toBeGreaterThan(fix.range[0]);
    expect(typeof fix.replacement).toBe("string");
  });

  test("LintRule can be implemented without fix method", () => {
    const ruleWithoutFix: LintRule = {
      id: "no-fix-rule",
      severity: "error",
      category: "style",
      check: () => [],
    };

    expect(ruleWithoutFix.fix).toBeUndefined();
  });

  test("all severity levels are valid", () => {
    const severities: Severity[] = ["error", "warning", "info"];

    severities.forEach((severity) => {
      const diagnostic: LintDiagnostic = {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "test",
        severity,
        message: "test",
      };

      expect(diagnostic.severity).toBe(severity);
    });
  });

  test("all categories are valid", () => {
    const categories: Category[] = [
      "correctness",
      "style",
      "performance",
      "security",
    ];

    categories.forEach((category) => {
      const rule: LintRule = {
        id: "test",
        severity: "error",
        category,
        check: () => [],
      };

      expect(rule.category).toBe(category);
    });
  });
});
