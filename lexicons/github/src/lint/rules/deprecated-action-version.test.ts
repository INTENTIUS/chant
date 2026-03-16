import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { deprecatedActionVersionRule } from "./deprecated-action-version";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA012: deprecated-action-version", () => {
  test("flags deprecated checkout version", () => {
    const ctx = createContext(`const s = "actions/checkout@v2";`);
    const diags = deprecatedActionVersionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("v2");
  });

  test("does not flag current version", () => {
    const ctx = createContext(`const s = "actions/checkout@v4";`);
    const diags = deprecatedActionVersionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
