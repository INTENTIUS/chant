import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl002ControlFlowResourceRule } from "./evl002-control-flow-resource";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL002: control-flow-resource", () => {
  test("rule metadata", () => {
    expect(evl002ControlFlowResourceRule.id).toBe("EVL002");
    expect(evl002ControlFlowResourceRule.severity).toBe("error");
    expect(evl002ControlFlowResourceRule.category).toBe("correctness");
  });

  test("allows top-level resource constructor", () => {
    const ctx = createContext(`export const bucket = new Bucket({ name: "x" });`);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(0);
  });

  test("flags resource inside if statement", () => {
    const ctx = createContext(`
      if (isProd) {
        const bucket = new Bucket({ name: "x" });
      }
    `);
    const diags = evl002ControlFlowResourceRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL002");
    expect(diags[0].message).toContain("control flow");
  });

  test("flags resource inside for loop", () => {
    const ctx = createContext(`
      for (let i = 0; i < 3; i++) {
        const bucket = new Bucket({ name: "x" });
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside for-of loop", () => {
    const ctx = createContext(`
      for (const x of items) {
        const bucket = new Bucket({ name: x });
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside for-in loop", () => {
    const ctx = createContext(`
      for (const k in obj) {
        const bucket = new Bucket({ name: k });
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside while loop", () => {
    const ctx = createContext(`
      while (true) {
        const bucket = new Bucket({ name: "x" });
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside do-while loop", () => {
    const ctx = createContext(`
      do {
        const bucket = new Bucket({ name: "x" });
      } while (false);
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside switch statement", () => {
    const ctx = createContext(`
      switch (env) {
        case "prod":
          const bucket = new Bucket({ name: "x" });
          break;
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags resource inside try block", () => {
    const ctx = createContext(`
      try {
        const bucket = new Bucket({ name: "x" });
      } catch (e) {}
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });

  test("flags nested control flow", () => {
    const ctx = createContext(`
      if (isProd) {
        for (const x of items) {
          const bucket = new Bucket({ name: "x" });
        }
      }
    `);
    expect(evl002ControlFlowResourceRule.check(ctx)).toHaveLength(1);
  });
});
