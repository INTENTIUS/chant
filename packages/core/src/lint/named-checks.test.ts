import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { registerCheck, getNamedCheck, listChecks } from "./named-checks";
import type { LintContext } from "./rule";

describe("named-checks", () => {
  test("registerCheck and getNamedCheck", () => {
    registerCheck("is-string-literal", (node) => ts.isStringLiteral(node));
    const check = getNamedCheck("is-string-literal");
    expect(check).toBeDefined();

    const sf = ts.createSourceFile("test.ts", `const a = "hello";`, ts.ScriptTarget.Latest, true);
    const ctx: LintContext = { sourceFile: sf, entities: [], filePath: "test.ts" };

    // Test with a string literal node
    let found = false;
    ts.forEachChild(sf, function visit(node) {
      if (ts.isStringLiteral(node)) {
        found = check!(node, ctx);
      }
      ts.forEachChild(node, visit);
    });
    expect(found).toBe(true);
  });

  test("getNamedCheck returns undefined for unknown check", () => {
    expect(getNamedCheck("nonexistent-check")).toBeUndefined();
  });

  test("listChecks returns registered check names", () => {
    registerCheck("test-check-a", () => true);
    registerCheck("test-check-b", () => false);
    const checks = listChecks();
    expect(checks).toContain("test-check-a");
    expect(checks).toContain("test-check-b");
  });
});
