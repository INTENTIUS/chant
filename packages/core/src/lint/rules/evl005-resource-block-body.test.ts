import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl005ResourceBlockBodyRule } from "./evl005-resource-block-body";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL005: resource-block-body", () => {
  test("rule metadata", () => {
    expect(evl005ResourceBlockBodyRule.id).toBe("EVL005");
    expect(evl005ResourceBlockBodyRule.severity).toBe("error");
    expect(evl005ResourceBlockBodyRule.category).toBe("correctness");
  });

  test("allows expression body", () => {
    const ctx = createContext(`resource(Bucket, (props) => ({ name: "x" }));`);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(0);
  });

  test("flags block body", () => {
    const ctx = createContext(`resource(Bucket, (props) => { return { name: "x" }; });`);
    const diags = evl005ResourceBlockBodyRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL005");
    expect(diags[0].message).toContain("Block body");
    expect(diags[0].message).toContain("expression body");
  });

  test("does not flag non-resource calls", () => {
    const ctx = createContext(`someOther(Type, (props) => { return {}; });`);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag resource with no second argument", () => {
    const ctx = createContext(`resource(Bucket);`);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag resource with non-arrow second argument", () => {
    const ctx = createContext(`resource(Bucket, factoryFn);`);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(0);
  });

  test("allows expression body with parenthesized object", () => {
    const ctx = createContext(`resource(Bucket, (props, siblings) => ({ name: siblings.other.arn }));`);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple violations", () => {
    const ctx = createContext(`
      resource(Bucket, (p) => { return {}; });
      resource(Role, (p) => { return {}; });
    `);
    expect(evl005ResourceBlockBodyRule.check(ctx)).toHaveLength(2);
  });
});
