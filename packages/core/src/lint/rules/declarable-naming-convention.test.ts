import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { declarableNamingConventionRule } from "./declarable-naming-convention";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  return {
    sourceFile,
    entities: [],
    filePath,
    lexicon: undefined,
  };
}

describe("COR005: declarable-naming-convention", () => {
  test("rule metadata", () => {
    expect(declarableNamingConventionRule.id).toBe("COR005");
    expect(declarableNamingConventionRule.severity).toBe("warning");
    expect(declarableNamingConventionRule.category).toBe("style");
  });

  test("triggers on PascalCase declarable name", () => {
    const ctx = createContext(`export const DataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR005");
    expect(diags[0].message).toContain("dataBucket");
  });

  test("triggers on UPPER_SNAKE_CASE declarable name", () => {
    const ctx = createContext(`export const DATA_BUCKET = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR005");
  });

  test("does not trigger on camelCase declarable name", () => {
    const ctx = createContext(`export const dataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on function calls (not new expressions)", () => {
    const ctx = createContext(`export const DataBucket = createBucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on non-exported declarations", () => {
    const ctx = createContext(`const DataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("reports correct line and column", () => {
    const ctx = createContext(`export const DataBucket = new Bucket({});`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].column).toBeGreaterThan(0);
  });
});
