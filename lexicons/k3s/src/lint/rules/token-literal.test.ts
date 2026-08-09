import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { tokenLiteralRule } from "./token-literal";

function createContext(code: string, fileName = "cluster.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("K3S001: literal join token", () => {
  test("flags a literal token inside new Server(...)", () => {
    const diags = tokenLiteralRule.check(
      createContext(`const s = new Server({ "cluster-init": true, token: "K10abc::server:secret" });`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("K3S001");
    expect(diags[0].severity).toBe("error");
  });

  test("flags a quoted agent-token key inside Agent(...)", () => {
    const diags = tokenLiteralRule.check(
      createContext(`const a = Agent({ server: "https://cp:6443", "agent-token": \`secret\` });`),
    );
    expect(diags).toHaveLength(1);
  });

  test("does not flag token-file", () => {
    const diags = tokenLiteralRule.check(
      createContext(`const s = new Server({ "token-file": "/etc/rancher/k3s/token" });`),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag a non-literal token", () => {
    const diags = tokenLiteralRule.check(
      createContext(`const s = new Server({ token: readTokenSomehow() });`),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag tokens outside Server/Agent constructions", () => {
    const diags = tokenLiteralRule.check(
      createContext(`const config = { token: "not-k3s's-business" };`),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag an empty literal", () => {
    const diags = tokenLiteralRule.check(createContext(`const s = new Server({ token: "" });`));
    expect(diags).toHaveLength(0);
  });
});
