import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { useConditionBuildersRule } from "./use-condition-builders";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA002: use-condition-builders", () => {
  test("flags ${{ in if property", () => {
    const ctx = createContext(`const j = new Job({ if: "\${{ github.ref == 'refs/heads/main' }}" });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA002");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Expression object in if", () => {
    const ctx = createContext(`const j = new Job({ if: branch("main") });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag string without ${{ in if", () => {
    const ctx = createContext(`const j = new Job({ if: "always()" });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
