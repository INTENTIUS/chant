import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl003DynamicPropertyAccessRule } from "./evl003-dynamic-property-access";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL003: dynamic-property-access", () => {
  test("rule metadata", () => {
    expect(evl003DynamicPropertyAccessRule.id).toBe("EVL003");
    expect(evl003DynamicPropertyAccessRule.severity).toBe("error");
    expect(evl003DynamicPropertyAccessRule.category).toBe("correctness");
  });

  test("allows dot property access", () => {
    const ctx = createContext(`const x = obj.prop;`);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(0);
  });

  test("allows string literal key", () => {
    const ctx = createContext(`const x = obj["key"];`);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(0);
  });

  test("allows numeric literal key", () => {
    const ctx = createContext(`const x = arr[0];`);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(0);
  });

  test("flags variable key", () => {
    const ctx = createContext(`const x = obj[key];`);
    const diags = evl003DynamicPropertyAccessRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL003");
    expect(diags[0].message).toContain("Dynamic property access");
  });

  test("flags expression key", () => {
    const ctx = createContext(`const x = obj[a + b];`);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(1);
  });

  test("flags function call key", () => {
    const ctx = createContext(`const x = obj[getKey()];`);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(1);
  });

  test("flags template literal key", () => {
    const ctx = createContext("const x = obj[`key-${i}`];");
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(1);
  });

  test("flags multiple violations", () => {
    const ctx = createContext(`
      const a = obj[x];
      const b = arr[y];
    `);
    expect(evl003DynamicPropertyAccessRule.check(ctx)).toHaveLength(2);
  });
});
