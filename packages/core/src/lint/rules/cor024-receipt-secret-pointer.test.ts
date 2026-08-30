import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { cor024ReceiptSecretPointerRule } from "./cor024-receipt-secret-pointer";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR024: receipt inputs reference secrets by pointer (#1833)", () => {
  test("rule metadata", () => {
    expect(cor024ReceiptSecretPointerRule.id).toBe("COR024");
    expect(cor024ReceiptSecretPointerRule.severity).toBe("error");
    expect(cor024ReceiptSecretPointerRule.category).toBe("correctness");
  });

  test("flags a receipt input reading a Secret entity's data attribute", () => {
    const ctx = createContext(`
      export const dbSecret = new SecretManagerSecret({ name: "db-password" });
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { password: dbSecret.data.password },
      });
    `);
    const diags = cor024ReceiptSecretPointerRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR024");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("dbSecret.data.password");
    expect(diags[0].message).toContain("name+version pointer");
    expect(diags[0].message).toContain("secretVersion");
  });

  test("flags a .value read on a Secret entity", () => {
    const ctx = createContext(`
      const apiToken = new ExternalSecret({ name: "api-token" });
      export const bootstrapped = EffectReceipt("bootstrapped", {
        effect: "bootstrap",
        flavor: "hash",
        inputs: { token: apiToken.value },
      });
    `);
    const diags = cor024ReceiptSecretPointerRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("apiToken.value");
  });

  test("const indirection fires: material extracted into a variable first", () => {
    const ctx = createContext(`
      const dbSecret = new SecretManagerSecret({ name: "db-password" });
      const material = dbSecret.data;
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { password: material.password },
      });
    `);
    const diags = cor024ReceiptSecretPointerRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("material");
  });

  test("bare material variable as an input fires", () => {
    const ctx = createContext(`
      const dbSecret = new SecretManagerSecret({ name: "db-password" });
      const material = dbSecret.stringData;
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { blob: material },
      });
    `);
    expect(cor024ReceiptSecretPointerRule.check(ctx)).toHaveLength(1);
  });

  test("passes: the name+version pointer form", () => {
    const ctx = createContext(`
      export const dbSecret = new SecretManagerSecret({ name: "db-password" });
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { secretName: dbSecret.name, secretVersion: 3 },
      });
    `);
    expect(cor024ReceiptSecretPointerRule.check(ctx)).toHaveLength(0);
  });

  test("passes: non-secret entity attributes and static inputs", () => {
    const ctx = createContext(`
      export const db = new Database({ name: "main" });
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { endpoint: db.endpoint, schema: "v3", value: db.port },
      });
    `);
    expect(cor024ReceiptSecretPointerRule.check(ctx)).toHaveLength(0);
  });

  test("passes: secret material read OUTSIDE a receipt's inputs is not this rule's concern", () => {
    const ctx = createContext(`
      const dbSecret = new SecretManagerSecret({ name: "db-password" });
      export const app = new Service({ env: { DB_PASSWORD: dbSecret.data.password } });
    `);
    expect(cor024ReceiptSecretPointerRule.check(ctx)).toHaveLength(0);
  });

  test("declareSecret provenance declarations are secret-rooted", () => {
    const ctx = createContext(`
      const dbSecret = declareSecret("db-password", { provenance: "referenced" });
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { v: dbSecret.value },
      });
    `);
    expect(cor024ReceiptSecretPointerRule.check(ctx)).toHaveLength(1);
  });
});
