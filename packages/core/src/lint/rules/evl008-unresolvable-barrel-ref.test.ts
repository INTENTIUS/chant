import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl008UnresolvableBarrelRefRule } from "./evl008-unresolvable-barrel-ref";
import type { LintContext } from "../rule";

function createContext(
  code: string,
  barrelExports?: Set<string>,
  filePath = "test.ts",
): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined, barrelExports };
}

describe("EVL008: unresolvable-barrel-ref", () => {
  test("rule metadata", () => {
    expect(evl008UnresolvableBarrelRefRule.id).toBe("EVL008");
    expect(evl008UnresolvableBarrelRefRule.severity).toBe("error");
    expect(evl008UnresolvableBarrelRefRule.category).toBe("correctness");
  });

  test("skips when no barrelExports provided", () => {
    const ctx = createContext(`
      export const $ = barrel(import.meta.dir);
      const x = $.myBucket;
    `);
    expect(evl008UnresolvableBarrelRefRule.check(ctx)).toHaveLength(0);
  });

  test("allows valid direct barrel reference", () => {
    const exports = new Set(["myBucket", "myRole"]);
    const ctx = createContext(
      `
      export const $ = barrel(import.meta.dir);
      const x = $.myBucket;
    `,
      exports,
    );
    expect(evl008UnresolvableBarrelRefRule.check(ctx)).toHaveLength(0);
  });

  test("flags invalid direct barrel reference", () => {
    const exports = new Set(["myBucket", "myRole"]);
    const ctx = createContext(
      `
      export const $ = barrel(import.meta.dir);
      const x = $.nonExistent;
    `,
      exports,
    );
    const diags = evl008UnresolvableBarrelRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL008");
    expect(diags[0].message).toContain("nonExistent");
    expect(diags[0].message).toContain("not exported");
  });

  test("allows valid namespace barrel reference", () => {
    const exports = new Set(["myBucket"]);
    const ctx = createContext(
      `
      import * as _ from "./_";
      const x = _.$.myBucket;
    `,
      exports,
    );
    expect(evl008UnresolvableBarrelRefRule.check(ctx)).toHaveLength(0);
  });

  test("flags invalid namespace barrel reference", () => {
    const exports = new Set(["myBucket"]);
    const ctx = createContext(
      `
      import * as _ from "./_";
      const x = _.$.missing;
    `,
      exports,
    );
    const diags = evl008UnresolvableBarrelRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("missing");
  });

  test("does not flag when no barrel usage in file", () => {
    const exports = new Set(["myBucket"]);
    const ctx = createContext(`const x = someObj.prop;`, exports);
    expect(evl008UnresolvableBarrelRefRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple invalid references", () => {
    const exports = new Set(["myBucket"]);
    const ctx = createContext(
      `
      export const $ = barrel(import.meta.dir);
      const a = $.missing1;
      const b = $.missing2;
    `,
      exports,
    );
    expect(evl008UnresolvableBarrelRefRule.check(ctx)).toHaveLength(2);
  });

  test("handles mixed valid and invalid", () => {
    const exports = new Set(["bucket", "role"]);
    const ctx = createContext(
      `
      export const $ = barrel(import.meta.dir);
      const a = $.bucket;
      const b = $.missing;
      const c = $.role;
    `,
      exports,
    );
    const diags = evl008UnresolvableBarrelRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("missing");
  });
});
