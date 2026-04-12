import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { chartMetadataRule } from "./chart-metadata";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "test.ts" };
}

describe("WHM001: chartMetadataRule", () => {
  test("passes when all required fields present", () => {
    const ctx = makeContext(`new Chart({ apiVersion: "v2", name: "my-app", version: "0.1.0" });`);
    expect(chartMetadataRule.check(ctx)).toHaveLength(0);
  });

  test("fails when name is missing", () => {
    const ctx = makeContext(`new Chart({ apiVersion: "v2", version: "0.1.0" });`);
    const diags = chartMetadataRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WHM001");
    expect(diags[0].message).toContain("name");
  });

  test("fails when all fields are missing", () => {
    const ctx = makeContext(`new Chart({});`);
    const diags = chartMetadataRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("name");
    expect(diags[0].message).toContain("version");
    expect(diags[0].message).toContain("apiVersion");
  });

  test("ignores non-Chart constructors", () => {
    const ctx = makeContext(`new Deployment({ name: "test" });`);
    expect(chartMetadataRule.check(ctx)).toHaveLength(0);
  });

  test("fails when version is missing", () => {
    const ctx = makeContext(`new Chart({ apiVersion: "v2", name: "my-app" });`);
    const diags = chartMetadataRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("version");
  });
});
