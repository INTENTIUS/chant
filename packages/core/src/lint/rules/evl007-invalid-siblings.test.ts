import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl007InvalidSiblingsRule } from "./evl007-invalid-siblings";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL007: invalid-siblings", () => {
  test("rule metadata", () => {
    expect(evl007InvalidSiblingsRule.id).toBe("EVL007");
    expect(evl007InvalidSiblingsRule.severity).toBe("error");
    expect(evl007InvalidSiblingsRule.category).toBe("correctness");
  });

  test("allows valid sibling access", () => {
    const ctx = createContext(`
      Composite((props) => ({
        bucket: resource(Bucket, () => ({ name: "x" })),
        role: resource(Role, (p, siblings) => ({ bucketArn: siblings.bucket.arn })),
      }));
    `);
    expect(evl007InvalidSiblingsRule.check(ctx)).toHaveLength(0);
  });

  test("flags invalid sibling key", () => {
    const ctx = createContext(`
      Composite((props) => ({
        bucket: resource(Bucket, () => ({ name: "x" })),
        role: resource(Role, (p, siblings) => ({ bucketArn: siblings.nonExistent.arn })),
      }));
    `);
    const diags = evl007InvalidSiblingsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL007");
    expect(diags[0].message).toContain("nonExistent");
    expect(diags[0].message).toContain("not a member");
  });

  test("allows access to all defined members", () => {
    const ctx = createContext(`
      Composite((props) => ({
        bucket: resource(Bucket, () => ({ name: "x" })),
        table: resource(Table, () => ({ name: "y" })),
        role: resource(Role, (p, siblings) => ({
          bucketArn: siblings.bucket.arn,
          tableArn: siblings.table.arn,
        })),
      }));
    `);
    expect(evl007InvalidSiblingsRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag when no siblings parameter", () => {
    const ctx = createContext(`
      Composite((props) => ({
        bucket: resource(Bucket, (p) => ({ name: "x" })),
      }));
    `);
    expect(evl007InvalidSiblingsRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag non-Composite calls", () => {
    const ctx = createContext(`
      someFunction((props) => ({
        bucket: resource(Bucket, (p, siblings) => ({ x: siblings.nonExistent })),
      }));
    `);
    expect(evl007InvalidSiblingsRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple invalid accesses", () => {
    const ctx = createContext(`
      Composite((props) => ({
        bucket: resource(Bucket, () => ({ name: "x" })),
        role: resource(Role, (p, siblings) => ({
          a: siblings.missing1.arn,
          b: siblings.missing2.arn,
        })),
      }));
    `);
    const diags = evl007InvalidSiblingsRule.check(ctx);
    expect(diags).toHaveLength(2);
  });
});
