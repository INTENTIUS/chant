import { describe, test, expect } from "vitest";
import { typecheckDTS } from "./typecheck";

describe("typecheckDTS", () => {
  test("passes valid .d.ts content", async () => {
    const result = await typecheckDTS("export declare class Foo { bar: string; }");
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test("fails on syntax errors", async () => {
    const result = await typecheckDTS("export declare class { }"); // missing class name
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("fails on undefined type references", async () => {
    const result = await typecheckDTS(
      "export declare class Foo { bar: UndefinedType; }",
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
