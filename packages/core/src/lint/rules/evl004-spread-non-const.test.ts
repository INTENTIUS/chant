import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl004SpreadNonConstRule } from "./evl004-spread-non-const";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL004: spread-non-const", () => {
  test("rule metadata", () => {
    expect(evl004SpreadNonConstRule.id).toBe("EVL004");
    expect(evl004SpreadNonConstRule.severity).toBe("error");
    expect(evl004SpreadNonConstRule.category).toBe("correctness");
  });

  test("allows spread from const variable", () => {
    const ctx = createContext(`
      const base = { a: 1, b: 2 };
      const merged = { ...base, c: 3 };
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("allows spread from object literal", () => {
    const ctx = createContext(`const x = { ...{ a: 1 }, b: 2 };`);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("allows spread from const property access", () => {
    const ctx = createContext(`
      const config = { base: { a: 1 } };
      const x = { ...config.base };
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("flags spread from let variable", () => {
    const ctx = createContext(`
      let base = { a: 1 };
      const x = { ...base };
    `);
    const diags = evl004SpreadNonConstRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL004");
    expect(diags[0].message).toContain("non-const");
  });

  test("flags spread from function call", () => {
    const ctx = createContext(`const x = { ...getDefaults() };`);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(1);
  });

  test("flags spread from method call", () => {
    const ctx = createContext(`const x = { ...config.getDefaults() };`);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(1);
  });

  test("flags array spread from non-const", () => {
    const ctx = createContext(`
      let items = [1, 2];
      const x = [...items, 3];
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(1);
  });

  test("allows array spread from const", () => {
    const ctx = createContext(`
      const items = [1, 2];
      const x = [...items, 3];
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple violations", () => {
    const ctx = createContext(`
      let a = {};
      let b = [];
      const x = { ...a };
      const y = [...b];
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(2);
  });

  test("allows spread inside Composite() factory callback", () => {
    const ctx = createContext(`
      function SecureApi(props) {
        return LambdaApi({
          timeout: 10,
          ...props,
        });
      }
    `);
    // This is a regular function, NOT inside Composite — should still flag
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(1);
  });

  test("allows spread inside Composite() definition", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({ ...props.roleConfig });
        return { role };
      });
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("allows spread inside _.Composite() definition", () => {
    const ctx = createContext(`
      const MyComp = _.Composite((props) => {
        const role = new _.Role({ ...props.defaults, name: props.name });
        return { role };
      });
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(0);
  });

  test("still flags outside Composite() in same file", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({ ...props.config });
        return { role };
      });
      let defaults = {};
      const x = { ...defaults };
    `);
    expect(evl004SpreadNonConstRule.check(ctx)).toHaveLength(1);
  });
});
