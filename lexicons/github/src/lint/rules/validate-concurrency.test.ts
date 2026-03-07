import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { validateConcurrencyRule } from "./validate-concurrency";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA016: validate-concurrency", () => {
  test("flags cancelInProgress without group", () => {
    const ctx = createContext(`const c = new Concurrency({ cancelInProgress: true });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA016");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag cancelInProgress with group", () => {
    const ctx = createContext(`const c = new Concurrency({ cancelInProgress: true, group: "ci-\${{ github.ref }}" });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag concurrency without cancelInProgress", () => {
    const ctx = createContext(`const c = new Concurrency({ group: "ci" });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
