import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl001NonLiteralExpressionRule } from "./evl001-non-literal-expression";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL001: non-literal-expression", () => {
  test("rule metadata", () => {
    expect(evl001NonLiteralExpressionRule.id).toBe("EVL001");
    expect(evl001NonLiteralExpressionRule.severity).toBe("error");
    expect(evl001NonLiteralExpressionRule.category).toBe("correctness");
  });

  test("allows string literal", () => {
    const ctx = createContext(`new Bucket({ bucketName: "my-bucket" });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows numeric literal", () => {
    const ctx = createContext(`new Queue({ maxSize: 100 });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows boolean literal", () => {
    const ctx = createContext(`new Bucket({ versioning: true });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows identifier reference", () => {
    const ctx = createContext(`new Bucket({ encryption: myEncryption });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows property access", () => {
    const ctx = createContext(`new Bucket({ role: config.roleArn });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows object literal", () => {
    const ctx = createContext(`new Bucket({ tags: { env: "prod" } });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows array literal", () => {
    const ctx = createContext(`new Bucket({ items: [1, 2, 3] });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows template expression", () => {
    const ctx = createContext("new Bucket({ name: `prefix-${suffix}` });");
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows tagged template", () => {
    const ctx = createContext("new Bucket({ name: Sub`${AWS.StackName}-data` });");
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows binary expression", () => {
    const ctx = createContext(`new Queue({ timeout: base + 10 });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows conditional expression", () => {
    const ctx = createContext(`new Bucket({ versioning: isProd ? true : false });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows as cast", () => {
    const ctx = createContext(`new Bucket({ name: value as string });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("allows new expression as value", () => {
    const ctx = createContext(`new Outer({ inner: new Inner({}) });`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("flags function call", () => {
    const ctx = createContext(`new Bucket({ name: getName() });`);
    const diags = evl001NonLiteralExpressionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL001");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("statically evaluable");
  });

  test("flags method call", () => {
    const ctx = createContext(`new Bucket({ name: config.getName() });`);
    const diags = evl001NonLiteralExpressionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL001");
  });

  test("flags await expression", () => {
    const ctx = createContext(`new Bucket({ data: await fetchData() });`);
    const diags = evl001NonLiteralExpressionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL001");
  });

  test("flags multiple violations", () => {
    const ctx = createContext(`new Bucket({ a: foo(), b: bar() });`);
    const diags = evl001NonLiteralExpressionRule.check(ctx);
    expect(diags).toHaveLength(2);
  });

  test("does not flag constructor with no arguments", () => {
    const ctx = createContext(`new Bucket();`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag constructor with non-object argument", () => {
    const ctx = createContext(`new SomeClass("string");`);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag inside Composite() factory callback", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.policyStatements
            ? props.policyStatements.map(s => ({ Effect: s.effect }))
            : undefined,
        });
        return { role };
      });
    `);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag inside _.Composite() factory callback", () => {
    const ctx = createContext(`
      const MyComp = _.Composite((props) => {
        const func = new _.Function({ name: props.name });
        return { func };
      });
    `);
    expect(evl001NonLiteralExpressionRule.check(ctx)).toHaveLength(0);
  });

  test("still flags outside Composite() in same file", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({ name: props.name });
        return { role };
      });
      const bucket = new Bucket({ name: getName() });
    `);
    const diags = evl001NonLiteralExpressionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL001");
  });
});
