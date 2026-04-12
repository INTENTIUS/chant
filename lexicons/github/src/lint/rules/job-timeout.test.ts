import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { jobTimeoutRule } from "./job-timeout";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA014: job-timeout", () => {
  test("flags Job without timeoutMinutes", () => {
    const ctx = createContext(`const j = new Job({ "runs-on": "ubuntu-latest" });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA014");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Job with timeoutMinutes", () => {
    const ctx = createContext(`const j = new Job({ "runs-on": "ubuntu-latest", timeoutMinutes: 30 });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-Job constructors", () => {
    const ctx = createContext(`const s = new Step({ run: "test" });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
