import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { suggestCacheRule } from "./suggest-cache";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA015: suggest-cache", () => {
  test("flags SetupNode in steps without Cache", () => {
    const ctx = createContext(`const j = new Job({ steps: [SetupNode({ nodeVersion: "22" })] });`);
    const diags = suggestCacheRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA015");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag SetupNode with cache prop", () => {
    const ctx = createContext(`const j = new Job({ steps: [SetupNode({ nodeVersion: "22", cache: "npm" })] });`);
    const diags = suggestCacheRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
