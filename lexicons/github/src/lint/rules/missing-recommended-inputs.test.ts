import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { missingRecommendedInputsRule } from "./missing-recommended-inputs";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA010: missing-recommended-inputs", () => {
  test("flags SetupNode without version", () => {
    const ctx = createContext(`const step = SetupNode({ cache: "npm" });`);
    const diags = missingRecommendedInputsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA010");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("SetupNode");
  });

  test("does not flag SetupNode with nodeVersion", () => {
    const ctx = createContext(`const step = SetupNode({ nodeVersion: "22" });`);
    const diags = missingRecommendedInputsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
