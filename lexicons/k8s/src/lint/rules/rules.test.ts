import { describe, test, expect } from "bun:test";
import { hardcodedNamespaceRule } from "./hardcoded-namespace";
import * as ts from "typescript";

function createContext(code: string) {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return { sourceFile } as any;
}

describe("WK8001: Hardcoded Namespace", () => {
  test("rule metadata", () => {
    expect(hardcodedNamespaceRule.id).toBe("WK8001");
    expect(hardcodedNamespaceRule.severity).toBe("warning");
    expect(hardcodedNamespaceRule.category).toBe("correctness");
  });

  test("flags namespace: 'production' string literal", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "production" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WK8001");
    expect(diags[0].message).toContain("production");
  });

  test("flags namespace: 'default' string literal", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "default" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("default");
  });

  test("does NOT flag namespace: myVar (variable reference)", () => {
    const ctx = createContext(
      `const ns = "production"; new Deployment({ metadata: { namespace: ns } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    // Only the string literal assignment to `namespace` key counts
    // Variable references should not be flagged
    const nsFlags = diags.filter((d) => d.ruleId === "WK8001");
    expect(nsFlags.length).toBe(0);
  });

  test("does NOT flag empty namespace string", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags multiple hardcoded namespaces", () => {
    const ctx = createContext(`
      const a = new Deployment({ metadata: { namespace: "staging" } });
      const b = new Service({ metadata: { namespace: "prod" } });
    `);
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(2);
  });
});
