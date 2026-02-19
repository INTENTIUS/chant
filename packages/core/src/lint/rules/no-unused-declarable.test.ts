import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noUnusedDeclarableRule } from "./no-unused-declarable";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR004: no-unused-declarable", () => {
  test("rule metadata", () => {
    expect(noUnusedDeclarableRule.id).toBe("COR004");
    expect(noUnusedDeclarableRule.severity).toBe("warning");
    expect(noUnusedDeclarableRule.category).toBe("correctness");
  });

  test("flags exported declarable that is never referenced", () => {
    const ctx = createContext(`export const bucket = new Bucket({ bucketName: "x" });`);
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR004");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("bucket");
    expect(diags[0].message).toContain("never referenced");
  });

  test("does not flag declarable that is referenced by another declarable", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ bucketName: "x" });\n` +
        `export const fn = new Function({ bucket: bucket.arn });`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    // bucket is referenced by fn, but fn itself is unreferenced
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("fn");
  });

  test("does not flag declarable referenced via namespace import style", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\n` +
        `export const bucket = new td.Bucket({ bucketName: "x" });\n` +
        `export const fn = new td.Function({ env: { BUCKET: bucket.arn } });`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    // bucket is referenced, fn is not
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("fn");
  });

  test("OK for non-declarable exports (plain objects, functions)", () => {
    const ctx = createContext(
      `export const config = { region: "us-east-1" };\n` +
        `export function helper() { return 1; }`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK for non-exported declarable (that's COR008's job)", () => {
    const ctx = createContext(`const bucket = new Bucket({ bucketName: "x" });`);
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK for new expression with lowercase name (not a declarable)", () => {
    const ctx = createContext(`export const obj = new someFactory();`);
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags multiple unused declarables", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ bucketName: "x" });\n` +
        `export const role = new Role({ roleName: "y" });\n` +
        `export const fn = new Function({});`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(3);
    const names = diags.map((d) => d.message);
    expect(names.some((m) => m.includes("bucket"))).toBe(true);
    expect(names.some((m) => m.includes("role"))).toBe(true);
    expect(names.some((m) => m.includes("fn"))).toBe(true);
  });

  test("flags only unused declarables when some are referenced", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ bucketName: "x" });\n` +
        `export const role = new Role({ roleName: "y" });\n` +
        `export const fn = new Function({ bucket: bucket.arn, role: role.arn });`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    // bucket and role are referenced by fn, but fn is unreferenced
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("fn");
  });

  test("reports correct file path", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({ bucketName: "x" });`,
      "infra/storage.ts",
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("infra/storage.ts");
  });

  test("reports correct line and column", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\n` +
        `export const bucket = new td.Bucket({ bucketName: "x" });`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].column).toBe(1);
  });

  test("detects reference as function argument", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({});\n` + `console.log(bucket);`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("detects reference in array literal", () => {
    const ctx = createContext(
      `export const bucket = new Bucket({});\n` + `export const list = [bucket];`,
    );
    const diags = noUnusedDeclarableRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
