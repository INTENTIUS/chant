import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { noHardcodedSecretsRule } from "./no-hardcoded-secrets";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA003: no-hardcoded-secrets", () => {
  test("flags ghp_ prefix", () => {
    const ctx = createContext(`const token = "ghp_1234567890abcdef";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA003");
    expect(diags[0].severity).toBe("error");
  });

  test("flags ghs_ prefix", () => {
    const ctx = createContext(`const token = "ghs_abcdef1234567890";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag normal strings", () => {
    const ctx = createContext(`const name = "my-github-repo";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
