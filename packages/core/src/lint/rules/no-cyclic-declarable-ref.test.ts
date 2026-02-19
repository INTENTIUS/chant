import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noCyclicDeclarableRefRule } from "./no-cyclic-declarable-ref";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR011: no-cyclic-declarable-ref", () => {
  test("rule metadata", () => {
    expect(noCyclicDeclarableRefRule.id).toBe("COR011");
    expect(noCyclicDeclarableRefRule.severity).toBe("error");
    expect(noCyclicDeclarableRefRule.category).toBe("correctness");
  });

  test("flags direct cycle: A references B, B references A", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ role: role.arn });\n` +
        `export const role = new Role({ bucket: bucket.bucketName });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("bucket");
    expect(diags[0].message).toContain("role");
    expect(diags[0].message).toContain("Circular reference detected");
  });

  test("flags transitive cycle: A→B→C→A", () => {
    const ctx = createContext(
      `export const a = new ResourceA({ ref: b.id });\n` +
        `export const b = new ResourceB({ ref: c.id });\n` +
        `export const c = new ResourceC({ ref: a.id });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("a");
    expect(diags[0].message).toContain("b");
    expect(diags[0].message).toContain("c");
  });

  test("OK: linear chain A→B→C (no cycle)", () => {
    const ctx = createContext(
      `export const a = new ResourceA({});\n` +
        `export const b = new ResourceB({ ref: a.id });\n` +
        `export const c = new ResourceC({ ref: b.id });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK: no cross-references between declarables", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ bucketName: "x" });\n` +
        `export const role = new Role({ roleName: "y" });\n` +
        `export const fn = new Function({ name: "z" });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK: single declarable (cannot form a cycle)", () => {
    const ctx = createContext(`export const bucket = new Bucket({ bucketName: "x" });`);
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags cycle with namespace import style", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\n` +
        `export const bucket = new td.Bucket({ role: role.arn });\n` +
        `export const role = new td.Role({ bucket: bucket.bucketName });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Circular reference detected");
  });

  test("reports correct file path", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ role: role.arn });\n` +
        `export const role = new Role({ bucket: bucket.bucketName });`,
      "infra/storage.ts",
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("infra/storage.ts");
  });

  test("reports correct line and column", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\n` +
        `export const bucket = new td.Bucket({ role: role.arn });\n` +
        `export const role = new td.Role({ bucket: bucket.bucketName });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].column).toBe(1);
  });

  test("message includes arrow-separated cycle path", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ role: role.arn });\n` +
        `export const role = new Role({ bucket: bucket.bucketName });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    // Should contain the cycle path with arrows
    expect(diags[0].message).toMatch(/\u2192/);
    expect(diags[0].message).toContain("Break the cycle by restructuring your declarations");
  });

  test("OK: non-exported declarables are ignored", () => {
    const ctx = createContext(
      `const bucket = new Bucket({ role: role.arn });\n` +
        `const role = new Role({ bucket: bucket.bucketName });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("detects cycle via direct identifier reference (not property access)", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ dep: role });\n` +
        `export const role = new Role({ dep: bucket });`,
    );
    const diags = noCyclicDeclarableRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Circular reference detected");
  });
});
