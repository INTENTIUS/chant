import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noStringRefRule } from "./no-string-ref";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR003: no-string-ref", () => {
  test("rule metadata", () => {
    expect(noStringRefRule.id).toBe("COR003");
    expect(noStringRefRule.severity).toBe("warning");
    expect(noStringRefRule.category).toBe("correctness");
  });

  test("flags td.GetAtt()", () => {
    const ctx = createContext(`const arn = td.GetAtt("myBucket", "Arn");`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR003");
    expect(diags[0].message).toContain("GetAtt");
  });

  test("flags td.Ref()", () => {
    const ctx = createContext(`const id = td.Ref("myBucket");`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR003");
    expect(diags[0].message).toContain("Ref");
  });

  test("flags bare GetAtt()", () => {
    const ctx = createContext(`const arn = GetAtt("myBucket", "Arn");`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR003");
    expect(diags[0].message).toContain("GetAtt");
  });

  test("flags bare Ref()", () => {
    const ctx = createContext(`const id = Ref("myBucket");`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR003");
    expect(diags[0].message).toContain("Ref");
  });

  test("allows AttrRef property access", () => {
    const ctx = createContext(`const arn = bucket.arn;`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("allows resource constructor", () => {
    const ctx = createContext(`const bucket = new td.Bucket({ bucketName: "my-bucket" });`);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("allows Sub/If/Join intrinsics", () => {
    const ctx = createContext(
      [
        `const a = td.Sub("arn:\${TestDom::AccountId}");`,
        `const b = td.If("cond", "a", "b");`,
        `const c = td.Join("-", ["a", "b"]);`,
      ].join("\n")
    );
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("multiple violations", () => {
    const ctx = createContext(
      [
        `const a = GetAtt("bucket1", "Arn");`,
        `const b = td.GetAtt("bucket2", "DomainName");`,
        `const c = GetAtt("bucket3", "WebsiteURL");`,
      ].join("\n")
    );
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(3);
    expect(diags.every((d) => d.ruleId === "COR003")).toBe(true);
  });

  test("correct line and column", () => {
    const code = [
      `const x = 1;`,
      `const arn = GetAtt("myBucket", "Arn");`,
      `const y = 2;`,
    ].join("\n");
    const ctx = createContext(code);
    const diags = noStringRefRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].column).toBe(13);
    expect(diags[0].file).toBe("test.ts");
  });
});
