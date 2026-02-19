import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { cor017CompositeNameMatchRule } from "./cor017-composite-name-match";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR017: composite-name-match", () => {
  test("rule metadata", () => {
    expect(cor017CompositeNameMatchRule.id).toBe("COR017");
    expect(cor017CompositeNameMatchRule.severity).toBe("error");
    expect(cor017CompositeNameMatchRule.category).toBe("correctness");
  });

  test("allows matching name", () => {
    const ctx = createContext(`
      const LambdaApi = Composite((props) => {
        return { role: new Role({}) };
      }, "LambdaApi");
    `);
    expect(cor017CompositeNameMatchRule.check(ctx)).toHaveLength(0);
  });

  test("allows matching name with _.Composite", () => {
    const ctx = createContext(`
      const LambdaApi = _.Composite((props) => {
        return { role: new Role({}) };
      }, "LambdaApi");
    `);
    expect(cor017CompositeNameMatchRule.check(ctx)).toHaveLength(0);
  });

  test("flags mismatched name", () => {
    const ctx = createContext(`
      const LambdaApi = Composite((props) => {
        return { role: new Role({}) };
      }, "MyFunction");
    `);
    const diags = cor017CompositeNameMatchRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR017");
    expect(diags[0].message).toContain('"MyFunction"');
    expect(diags[0].message).toContain('"LambdaApi"');
    expect(diags[0].fix).toBeDefined();
    expect(diags[0].fix!.replacement).toBe('"LambdaApi"');
  });

  test("flags missing name argument", () => {
    const ctx = createContext(`
      const LambdaApi = Composite((props) => {
        return { role: new Role({}) };
      });
    `);
    const diags = cor017CompositeNameMatchRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR017");
    expect(diags[0].message).toContain("missing a name argument");
    expect(diags[0].message).toContain('"LambdaApi"');
    expect(diags[0].fix).toBeDefined();
    expect(diags[0].fix!.replacement).toBe(', "LambdaApi"');
  });

  test("flags non-literal name argument", () => {
    const ctx = createContext(`
      const LambdaApi = Composite((props) => {
        return { role: new Role({}) };
      }, getName());
    `);
    const diags = cor017CompositeNameMatchRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("string literal");
    expect(diags[0].fix).toBeDefined();
    expect(diags[0].fix!.replacement).toBe('"LambdaApi"');
  });

  test("does not flag non-Composite calls", () => {
    const ctx = createContext(`
      const thing = createThing((props) => {
        return { role: new Role({}) };
      }, "wrong");
    `);
    expect(cor017CompositeNameMatchRule.check(ctx)).toHaveLength(0);
  });

  test("handles _.Composite with mismatch", () => {
    const ctx = createContext(`
      const SecureStorage = _.Composite((props) => {
        return { bucket: new Bucket({}) };
      }, "Storage");
    `);
    const diags = cor017CompositeNameMatchRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].fix!.replacement).toBe('"SecureStorage"');
  });

  test("handles export const pattern", () => {
    const ctx = createContext(`
      export const LambdaApi = Composite((props) => {
        return { role: new Role({}) };
      }, "LambdaApi");
    `);
    expect(cor017CompositeNameMatchRule.check(ctx)).toHaveLength(0);
  });
});
