import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl006BarrelUsageRule } from "./evl006-barrel-usage";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL006: barrel-usage", () => {
  test("rule metadata", () => {
    expect(evl006BarrelUsageRule.id).toBe("EVL006");
    expect(evl006BarrelUsageRule.severity).toBe("error");
    expect(evl006BarrelUsageRule.category).toBe("correctness");
  });

  test("allows correct barrel usage", () => {
    const ctx = createContext(`export const $ = barrel(import.meta.dir);`);
    expect(evl006BarrelUsageRule.check(ctx)).toHaveLength(0);
  });

  test("flags string literal argument", () => {
    const ctx = createContext(`export const $ = barrel("./src");`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("import.meta.dir"))).toBe(true);
  });

  test("flags variable argument", () => {
    const ctx = createContext(`export const $ = barrel(myDir);`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("import.meta.dir"))).toBe(true);
  });

  test("flags non-exported barrel", () => {
    const ctx = createContext(`const $ = barrel(import.meta.dir);`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("export const $"))).toBe(true);
  });

  test("flags barrel not assigned to $", () => {
    const ctx = createContext(`export const myBarrel = barrel(import.meta.dir);`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("export const $"))).toBe(true);
  });

  test("flags let instead of const", () => {
    const ctx = createContext(`export let $ = barrel(import.meta.dir);`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("export const $"))).toBe(true);
  });

  test("does not flag non-barrel calls", () => {
    const ctx = createContext(`export const x = someFunction(import.meta.dir);`);
    expect(evl006BarrelUsageRule.check(ctx)).toHaveLength(0);
  });

  test("flags no arguments", () => {
    const ctx = createContext(`export const $ = barrel();`);
    const diags = evl006BarrelUsageRule.check(ctx);
    expect(diags.some((d) => d.message.includes("import.meta.dir"))).toBe(true);
  });
});
