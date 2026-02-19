import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noRedundantValueCastRule } from "./no-redundant-value-cast";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR015: no-redundant-value-cast", () => {
  test("rule metadata", () => {
    expect(noRedundantValueCastRule.id).toBe("COR015");
    expect(noRedundantValueCastRule.severity).toBe("warning");
    expect(noRedundantValueCastRule.category).toBe("style");
  });

  test("flags as Value<string> cast", () => {
    const ctx = createContext(`const x = role.arn as Value<string>;`);
    const diags = noRedundantValueCastRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR015");
    expect(diags[0].message).toContain("Redundant");
  });

  test("flags as Value<number> cast", () => {
    const ctx = createContext(`const x = something as Value<number>;`);
    const diags = noRedundantValueCastRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag other as casts", () => {
    const ctx = createContext(`const x = something as string;`);
    const diags = noRedundantValueCastRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag when no cast is used", () => {
    const ctx = createContext(`const x = role.arn;`);
    const diags = noRedundantValueCastRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags multiple casts in one file", () => {
    const ctx = createContext(
      `const a = x.arn as Value<string>;\nconst b = y.id as Value<string>;`
    );
    const diags = noRedundantValueCastRule.check(ctx);
    expect(diags).toHaveLength(2);
  });
});
