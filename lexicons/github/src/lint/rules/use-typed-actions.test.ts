import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { useTypedActionsRule } from "./use-typed-actions";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA001: use-typed-actions", () => {
  test("flags raw uses: string for known action", () => {
    const ctx = createContext(`const s = new Step({ uses: "actions/checkout@v4" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("Checkout");
  });

  test("flags actions/setup-node", () => {
    const ctx = createContext(`const s = new Step({ uses: "actions/setup-node@v4" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("SetupNode");
  });

  test("does not flag unknown action", () => {
    const ctx = createContext(`const s = new Step({ uses: "custom/action@v1" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-uses property", () => {
    const ctx = createContext(`const s = new Step({ run: "npm test" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
