import { describe, test, expect } from "bun:test";
import { hardcodedProjectRule } from "./hardcoded-project";
import { hardcodedRegionRule } from "./hardcoded-region";
import { publicIamRule } from "./public-iam";
import * as ts from "typescript";

function makeContext(code: string) {
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile };
}

describe("WGC001: hardcoded project", () => {
  test("has correct id and severity", () => {
    expect(hardcodedProjectRule.id).toBe("WGC001");
    expect(hardcodedProjectRule.severity).toBe("warning");
  });
});

describe("WGC002: hardcoded region", () => {
  test("detects hardcoded region", () => {
    const ctx = makeContext('const region = "us-central1";');
    const diags = hardcodedRegionRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("WGC002");
    expect(diags[0].message).toContain("us-central1");
  });

  test("detects hardcoded zone", () => {
    const ctx = makeContext('const zone = "us-central1-a";');
    const diags = hardcodedRegionRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("us-central1-a");
  });

  test("no diagnostics for non-region strings", () => {
    const ctx = makeContext('const name = "my-app";');
    const diags = hardcodedRegionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

describe("WGC003: public IAM", () => {
  test("detects allUsers", () => {
    const ctx = makeContext('const member = "allUsers";');
    const diags = publicIamRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("WGC003");
    expect(diags[0].message).toContain("allUsers");
  });

  test("detects allAuthenticatedUsers", () => {
    const ctx = makeContext('const member = "allAuthenticatedUsers";');
    const diags = publicIamRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("allAuthenticatedUsers");
  });

  test("no diagnostics for normal member", () => {
    const ctx = makeContext('const member = "user:admin@example.com";');
    const diags = publicIamRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
