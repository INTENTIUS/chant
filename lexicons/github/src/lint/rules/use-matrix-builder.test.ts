import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { useMatrixBuilderRule } from "./use-matrix-builder";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA004: use-matrix-builder", () => {
  test("flags inline matrix object", () => {
    const ctx = createContext(`const s = new Strategy({ matrix: { "node-version": ["18", "20"] } });`);
    const diags = useMatrixBuilderRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA004");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag matrix reference", () => {
    const ctx = createContext(`const s = new Strategy({ matrix: myMatrix });`);
    const diags = useMatrixBuilderRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
