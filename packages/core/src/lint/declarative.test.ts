import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { rule } from "./declarative";
import type { RuleSpec } from "./declarative";
import type { LintContext } from "./rule";
import { registerCheck } from "./named-checks";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("declarative rule()", () => {
  test("creates a rule with correct metadata", () => {
    const spec: RuleSpec = {
      id: "TEST001",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Found a string literal",
    };
    const r = rule(spec);
    expect(r.id).toBe("TEST001");
    expect(r.severity).toBe("warning");
    expect(r.category).toBe("style");
  });

  test("reports diagnostics for matching nodes", () => {
    const spec: RuleSpec = {
      id: "TEST002",
      severity: "error",
      category: "correctness",
      selector: "string-literal",
      message: "No string literals allowed",
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello"; const b = "world";`);
    const diags = r.check(ctx);
    expect(diags).toHaveLength(2);
    expect(diags[0].ruleId).toBe("TEST002");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toBe("No string literals allowed");
  });

  test("returns no diagnostics when nothing matches", () => {
    const spec: RuleSpec = {
      id: "TEST003",
      severity: "warning",
      category: "style",
      selector: "resource",
      message: "Found a resource",
    };
    const r = rule(spec);
    const ctx = createContext(`const a = 42;`);
    expect(r.check(ctx)).toHaveLength(0);
  });

  test("message template replaces {node}", () => {
    const spec: RuleSpec = {
      id: "TEST004",
      severity: "info",
      category: "style",
      selector: "string-literal",
      message: "Found: {node}",
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello";`);
    const diags = r.check(ctx);
    expect(diags[0].message).toBe('Found: "hello"');
  });

  test("match.pattern filters by regex", () => {
    const spec: RuleSpec = {
      id: "TEST005",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      match: { pattern: /world/ },
      message: "Found world",
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello"; const b = "world";`);
    const diags = r.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("Found world");
  });

  test("match.check uses named check", () => {
    registerCheck("always-true", () => true);
    registerCheck("always-false", () => false);

    const specTrue: RuleSpec = {
      id: "TEST006A",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      match: { check: "always-true" },
      message: "matches",
    };
    const specFalse: RuleSpec = {
      id: "TEST006B",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      match: { check: "always-false" },
      message: "no match",
    };

    const ctx = createContext(`const a = "hello";`);
    expect(rule(specTrue).check(ctx)).toHaveLength(1);
    expect(rule(specFalse).check(ctx)).toHaveLength(0);
  });

  test("validate function filters nodes", () => {
    const spec: RuleSpec = {
      id: "TEST007",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Found string",
      validate: (node, _ctx) => {
        return ts.isStringLiteral(node) && node.text === "keep";
      },
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "keep"; const b = "skip";`);
    const diags = r.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("fix with replace kind", () => {
    const spec: RuleSpec = {
      id: "TEST008",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Replace string",
      fix: { kind: "replace", text: '"replaced"' },
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello";`);
    const diags = r.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].fix).toBeDefined();
    expect(diags[0].fix!.replacement).toBe('"replaced"');
    expect(diags[0].fix!.kind).toBe("replace");
  });

  test("fix with delete kind", () => {
    const spec: RuleSpec = {
      id: "TEST009",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Delete string",
      fix: { kind: "delete" },
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello";`);
    const diags = r.check(ctx);
    expect(diags[0].fix!.replacement).toBe("");
    expect(diags[0].fix!.kind).toBe("delete");
  });

  test("fix with resolve function", () => {
    const spec: RuleSpec = {
      id: "TEST010",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Transform string",
      fix: {
        kind: "replace",
        resolve: (node, sf) => `"${(node as ts.StringLiteral).text.toUpperCase()}"`,
      },
    };
    const r = rule(spec);
    const ctx = createContext(`const a = "hello";`);
    const diags = r.check(ctx);
    expect(diags[0].fix!.replacement).toBe('"HELLO"');
  });

  test("correct line and column positions", () => {
    const code = [
      `const x = 1;`,
      `const a = "target";`,
      `const y = 2;`,
    ].join("\n");
    const spec: RuleSpec = {
      id: "TEST011",
      severity: "warning",
      category: "style",
      selector: "string-literal",
      message: "Found",
    };
    const r = rule(spec);
    const ctx = createContext(code);
    const diags = r.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].file).toBe("test.ts");
  });

  test("produces same diagnostics as equivalent imperative rule", () => {
    // Declarative version
    const declarativeRule = rule({
      id: "CMP001",
      severity: "warning",
      category: "correctness",
      selector: "resource",
      message: "Found resource instantiation: {node}",
    });

    // Imperative equivalent
    const imperativeRule = {
      id: "CMP001",
      severity: "warning" as const,
      category: "correctness" as const,
      check(context: LintContext) {
        const diagnostics: { file: string; line: number; column: number; ruleId: string; severity: "warning"; message: string }[] = [];
        const sf = context.sourceFile;
        function visit(node: ts.Node) {
          if (ts.isNewExpression(node)) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            diagnostics.push({
              file: context.filePath,
              line: line + 1,
              column: character + 1,
              ruleId: "CMP001",
              severity: "warning",
              message: `Found resource instantiation: ${node.getText(sf)}`,
            });
          }
          ts.forEachChild(node, visit);
        }
        visit(sf);
        return diagnostics;
      },
    };

    const code = `const b = new Bucket({ name: "test" });\nconst t = new Table({});`;
    const ctx = createContext(code);

    const declDiags = declarativeRule.check(ctx);
    const impDiags = imperativeRule.check(ctx);

    expect(declDiags).toHaveLength(impDiags.length);
    for (let i = 0; i < declDiags.length; i++) {
      expect(declDiags[i].ruleId).toBe(impDiags[i].ruleId);
      expect(declDiags[i].severity).toBe(impDiags[i].severity);
      expect(declDiags[i].line).toBe(impDiags[i].line);
      expect(declDiags[i].column).toBe(impDiags[i].column);
      expect(declDiags[i].message).toBe(impDiags[i].message);
    }
  });
});
