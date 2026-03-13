import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { chartMetadataRule } from "./chart-metadata";
import { valuesNoSecretsRule } from "./values-no-secrets";
import { noHardcodedImageRule } from "./no-hardcoded-image";
import { valuesNoHelmTplRule } from "./values-no-helm-tpl";

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
});

describe("WHM002: valuesNoSecretsRule", () => {
  test("passes with empty values", () => {
    const ctx = makeContext(`new Values({});`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });

  test("warns on hardcoded password", () => {
    const ctx = makeContext(`new Values({ password: "hunter2" });`);
    const diags = valuesNoSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WHM002");
    expect(diags[0].message).toContain("password");
  });

  test("warns on hardcoded secret in nested object", () => {
    const ctx = makeContext(`new Values({ db: { secret: "s3cret" } });`);
    const diags = valuesNoSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("secret");
  });

  test("passes when secret value is empty", () => {
    const ctx = makeContext(`new Values({ password: "" });`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });

  test("passes for non-sensitive keys", () => {
    const ctx = makeContext(`new Values({ replicaCount: 3, name: "test" });`);
    expect(valuesNoSecretsRule.check(ctx)).toHaveLength(0);
  });
});

describe("WHM004: valuesNoHelmTplRule", () => {
  test("warns when Values prop uses v.xxx", () => {
    const ctx = makeContext(`new Values({ host: v.myHost });`);
    const diags = valuesNoHelmTplRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WHM004");
  });

  test("warns on nested v.xxx", () => {
    const ctx = makeContext(`new Values({ global: { hosts: { domain: v.cellDomain } } });`);
    expect(valuesNoHelmTplRule.check(ctx).length).toBeGreaterThan(0);
  });

  test("passes when Values props are static", () => {
    const ctx = makeContext(`new Values({ host: "localhost" });`);
    expect(valuesNoHelmTplRule.check(ctx)).toHaveLength(0);
  });

  test("passes for runtimeSlot() calls", () => {
    const ctx = makeContext(`new Values({ host: runtimeSlot("Cloud SQL IP") });`);
    expect(valuesNoHelmTplRule.check(ctx)).toHaveLength(0);
  });

  test("does not fire on non-Values constructors", () => {
    const ctx = makeContext(`new Deployment({ image: v.image });`);
    expect(valuesNoHelmTplRule.check(ctx)).toHaveLength(0);
  });

  test("warns on v.xxx pipe chain", () => {
    const ctx = makeContext(`new Values({ host: v.myHost.pipe("quote") });`);
    expect(valuesNoHelmTplRule.check(ctx)).toHaveLength(1);
  });
});

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
});
