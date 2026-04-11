import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { detectSecretsRule } from "./detect-secrets";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA020: detect-secrets", () => {
  test("flags AWS access key", () => {
    const ctx = createContext(`const key = "AKIAIOSFODNN7EXAMPLE";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA020");
    expect(diags[0].severity).toBe("error");
  });

  test("does not flag normal strings", () => {
    const ctx = createContext(`const name = "my-application";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
