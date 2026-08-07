import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { registryProxyPasswordRule } from "./registry-proxy-password";

function createContext(code: string, fileName = "cluster.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("K3D001: registry proxy password literal", () => {
  test("flags a literal password inside RegistryProxy(...)", () => {
    const diags = registryProxyPasswordRule.check(
      createContext(`const p = RegistryProxy({ remoteURL: "https://registry-1.docker.io", password: "hunter2" });`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("K3D001");
    expect(diags[0].severity).toBe("error");
  });

  test("flags a literal password inside new RegistryProxy(...)", () => {
    const diags = registryProxyPasswordRule.check(
      createContext(`const p = new RegistryProxy({ password: "hunter2" });`),
    );
    expect(diags).toHaveLength(1);
  });

  test("flags a literal password in a plain proxy object", () => {
    const diags = registryProxyPasswordRule.check(
      createContext(`const r = RegistryCreate({ proxy: { remoteURL: "https://x", password: \`hunter2\` } });`),
    );
    expect(diags).toHaveLength(1);
  });

  test("does not flag a password that is not a literal", () => {
    const diags = registryProxyPasswordRule.check(
      createContext(`const p = RegistryProxy({ password: process.env.REGISTRY_PASSWORD });`),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag unrelated password properties", () => {
    const diags = registryProxyPasswordRule.check(
      createContext(`const config = { database: { password: "not-k3d's-business" } };`),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag an empty literal", () => {
    const diags = registryProxyPasswordRule.check(createContext(`const p = RegistryProxy({ password: "" });`));
    expect(diags).toHaveLength(0);
  });
});
