import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ts } from "@intentius/chant/lint/typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { literalCredentialEnvRule } from "./literal-credential-env";

const FIXTURES = join(import.meta.dirname, "fixtures", "PROW001");

function lint(file: string) {
  const path = join(FIXTURES, file);
  const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
  return literalCredentialEnvRule.check({ sourceFile, entities: [], filePath: path } as unknown as LintContext);
}

describe("PROW001: a credential written into a job's environment", () => {
  test("the positive fixture is flagged at the literal", () => {
    const diags = lint("positive.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ ruleId: "PROW001", severity: "error", line: 8 });
    expect(diags[0].message).toContain("GITHUB_TOKEN is set to a literal");
  });

  test("the negative fixture is not", () => {
    expect(lint("negative.ts")).toEqual([]);
  });
});
