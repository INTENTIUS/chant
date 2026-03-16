import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { noHardcodedImageRule } from "./no-hardcoded-image";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "test.ts" };
}

describe("WHM003: noHardcodedImageRule", () => {
  test("warns on hardcoded image with tag", () => {
    const ctx = makeContext(`new Deployment({ spec: { containers: [{ image: "nginx:1.19" }] } });`);
    const diags = noHardcodedImageRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WHM003");
    expect(diags[0].message).toContain("nginx:1.19");
  });

  test("warns on registry/image:tag format", () => {
    const ctx = makeContext(`({ image: "registry.io/app:latest" })`);
    const diags = noHardcodedImageRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("passes when image is not a string literal (intrinsic)", () => {
    const ctx = makeContext(`({ image: printf("%s:%s", values.image.repo, values.image.tag) })`);
    expect(noHardcodedImageRule.check(ctx)).toHaveLength(0);
  });

  test("passes for image key without colon-tag pattern", () => {
    const ctx = makeContext(`({ image: "just-a-name" })`);
    expect(noHardcodedImageRule.check(ctx)).toHaveLength(0);
  });

  test("warns on multi-segment registry path", () => {
    const ctx = makeContext(`({ image: "gcr.io/my-project/my-app:v1.0" })`);
    const diags = noHardcodedImageRule.check(ctx);
    expect(diags).toHaveLength(1);
  });
});
