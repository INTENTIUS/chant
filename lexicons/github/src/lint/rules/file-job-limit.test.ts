import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { fileJobLimitRule } from "./file-job-limit";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("GHA007: file-job-limit", () => {
  test("flags file with more than 10 jobs", () => {
    const jobs = Array.from({ length: 11 }, (_, i) => `const j${i} = new Job({ "runs-on": "ubuntu-latest" });`).join("\n");
    const ctx = createContext(jobs);
    const diags = fileJobLimitRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA007");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("11");
  });

  test("does not flag 10 or fewer jobs", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => `const j${i} = new Job({ "runs-on": "ubuntu-latest" });`).join("\n");
    const ctx = createContext(jobs);
    const diags = fileJobLimitRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
