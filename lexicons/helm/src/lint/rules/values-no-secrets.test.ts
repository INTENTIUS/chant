import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { valuesNoSecretsRule } from "./values-no-secrets";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "test.ts" };
}

describe("WHM002: valuesNoSecretsRule", () => {
  test("passes with empty values", () => {
    const ctx = makeContext(`new Values({});`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });

  test("warns on hardcoded password", () => {
    const ctx = makeContext(`new Values({ password: "hunter2" });`);
    const diags = valuesNoSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WHM002");
    expect(diags[0].message).toContain("password");
  });

  test("warns on hardcoded secret in nested object", () => {
    const ctx = makeContext(`new Values({ db: { secret: "s3cret" } });`);
    const diags = valuesNoSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("secret");
  });

  test("passes when secret value is empty", () => {
    const ctx = makeContext(`new Values({ password: "" });`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });

  test("passes for non-sensitive keys", () => {
    const ctx = makeContext(`new Values({ replicaCount: 3, name: "test" });`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });

  test("warns on hardcoded token", () => {
    const ctx = makeContext(`new Values({ token: "abc123" });`);
    const diags = valuesNoSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("token");
  });
});
