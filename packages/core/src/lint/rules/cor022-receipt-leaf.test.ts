import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { cor022ReceiptLeafRule, collectReceiptVariables } from "./cor022-receipt-leaf";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR022: effect receipt is a leaf (#1833)", () => {
  test("rule metadata", () => {
    expect(cor022ReceiptLeafRule.id).toBe("COR022");
    expect(cor022ReceiptLeafRule.severity).toBe("error");
    expect(cor022ReceiptLeafRule.category).toBe("correctness");
  });

  test("flags a property access on a receipt inside another declarable", () => {
    const ctx = createContext(`
      export const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
      export const app = new Service({ marker: seeded.effect });
    `);
    const diags = cor022ReceiptLeafRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR022");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain('"seeded" is an effect receipt');
    expect(diags[0].message).toContain('"effect"');
    expect(diags[0].message).toContain("sole writer");
  });

  test("const indirection fires: const r = EffectReceipt(...); other.prop = r.something", () => {
    const ctx = createContext(`
      const r = EffectReceipt("migrated", { effect: "schema-migrate", flavor: "hash" });
      export const other = new Store({});
      other.prop = r.something;
    `);
    const diags = cor022ReceiptLeafRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"r" is an effect receipt');
    expect(diags[0].message).toContain('"something"');
  });

  test("an alias of a receipt is still the receipt", () => {
    const ctx = createContext(`
      const r = EffectReceipt("migrated", { effect: "schema-migrate", flavor: "existence" });
      const alias = r;
      export const svc = new Service({ tag: alias.name });
    `);
    const diags = cor022ReceiptLeafRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"alias"');
  });

  test("element access fires like property access", () => {
    const ctx = createContext(`
      const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
      export const svc = new Service({ tag: r["effect"] });
    `);
    const diags = cor022ReceiptLeafRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"effect"');
  });

  test("namespaced factory call is recognized", () => {
    const ctx = createContext(`
      const r = chant.EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
      export const svc = new Service({ tag: r.effect });
    `);
    expect(cor022ReceiptLeafRule.check(ctx)).toHaveLength(1);
  });

  test("passes: a receipt that nothing dereferences", () => {
    const ctx = createContext(`
      import { EffectReceipt } from "@intentius/chant";
      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "hash",
        inputs: { schema: "v3" },
      });
      export const app = new Service({ image: "app:1" });
    `);
    expect(cor022ReceiptLeafRule.check(ctx)).toHaveLength(0);
  });

  test("passes: referencing the receipt value itself (no attribute access)", () => {
    const ctx = createContext(`
      const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
      registerReceipt(r);
    `);
    expect(cor022ReceiptLeafRule.check(ctx)).toHaveLength(0);
  });

  test("passes: property access on a non-receipt declarable", () => {
    const ctx = createContext(`
      export const db = new Database({ name: "main" });
      export const app = new Service({ endpoint: db.endpoint });
    `);
    expect(cor022ReceiptLeafRule.check(ctx)).toHaveLength(0);
  });

  test("collectReceiptVariables resolves aliases declared before the receipt", () => {
    const sf = ts.createSourceFile(
      "t.ts",
      `
      const early = late;
      const late = EffectReceipt("r", { effect: "e", flavor: "existence" });
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const vars = collectReceiptVariables(sf);
    expect(vars.has("late")).toBe(true);
    expect(vars.has("early")).toBe(true);
  });
});
