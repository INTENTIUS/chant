import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { fileDeclarableLimitRule } from "./file-declarable-limit";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  return {
    sourceFile,
    entities: [],
    filePath,
    lexicon: undefined,
  };
}

function makeNewExprs(names: string[]): string {
  return names.map((n) => `const x = new ${n}({ name: "a" });`).join("\n");
}

describe("COR009: file-declarable-limit", () => {
  test("rule metadata", () => {
    expect(fileDeclarableLimitRule.id).toBe("COR009");
    expect(fileDeclarableLimitRule.severity).toBe("warning");
    expect(fileDeclarableLimitRule.category).toBe("style");
  });

  test("does not warn with 3 Declarable instances", () => {
    const code = makeNewExprs(["Bucket", "Table", "Queue"]);
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not warn with exactly 8 Declarable instances", () => {
    const code = makeNewExprs([
      "Bucket",
      "Table",
      "Queue",
      "Topic",
      "Function",
      "Role",
      "Policy",
      "Stack",
    ]);
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("warns with 9 Declarable instances", () => {
    const code = makeNewExprs([
      "Bucket",
      "Table",
      "Queue",
      "Topic",
      "Function",
      "Role",
      "Policy",
      "Stack",
      "Alarm",
    ]);
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR009");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBe(1);
    expect(diagnostics[0].message).toBe(
      "File contains 9 Declarable instances (limit: 8) — consider splitting into separate files by concern",
    );
  });

  test("does not count non-Declarable new expressions", () => {
    const code = [
      `const d = new Date();`,
      `const m = new Map();`,
      `const s = new Set();`,
      `const e = new Error("oops");`,
      `const r = new RegExp("abc");`,
      `const a = new Array(10);`,
      `const w = new WeakMap();`,
      `const p = new Promise(() => {});`,
      `const u = new URL("https://example.com");`,
    ].join("\n");
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("only counts capitalized constructors as Declarable", () => {
    // Mix of lowercase (non-Declarable) and uppercase (Declarable)
    const code = [
      ...Array.from({ length: 10 }, () => `new foo();`),
      `new Bucket({ name: "a" });`,
    ].join("\n");
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("reports correct file path", () => {
    const code = makeNewExprs([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    const context = createContext(code, "infra/my-stack.ts");
    const diagnostics = fileDeclarableLimitRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].file).toBe("infra/my-stack.ts");
  });

  test("message includes actual count", () => {
    const code = makeNewExprs([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
    ]);
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("11 Declarable instances");
  });
});
