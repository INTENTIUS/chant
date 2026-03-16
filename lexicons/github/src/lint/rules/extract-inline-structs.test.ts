import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { extractInlineStructsRule } from "./extract-inline-structs";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA005: extract-inline-structs", () => {
  test("flags deeply nested objects in Job constructor", () => {
    const ctx = createContext(`const j = new Job({ on: { push: { branches: { pattern: "main" } } } });`);
    const diags = extractInlineStructsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA005");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag shallow nesting", () => {
    const ctx = createContext(`const j = new Job({ env: { NODE_ENV: "production" } });`);
    const diags = extractInlineStructsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
