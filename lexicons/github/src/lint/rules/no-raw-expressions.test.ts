import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { noRawExpressionsRule } from "./no-raw-expressions";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA008: no-raw-expressions", () => {
  test("flags unknown context in ${{ }}", () => {
    const ctx = createContext(`const x = "\${{ custom.unknown }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA008");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag known contexts", () => {
    const ctx = createContext(`const x = "\${{ github.ref }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag secrets context", () => {
    const ctx = createContext(`const x = "\${{ secrets.MY_TOKEN }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
