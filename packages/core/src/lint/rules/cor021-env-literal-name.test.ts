import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { cor021EnvLiteralNameRule } from "./cor021-env-literal-name";
import type { LintContext, LintProjectConfig } from "../rule";

const MULTI_ENV_PARAM_BOUND: LintProjectConfig = {
  environments: ["dev", "prod"],
  ownership: { stack: "billing", env: { param: "env" } },
};

function createContext(code: string, projectConfig?: LintProjectConfig, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined, projectConfig };
}

describe("COR021: literal name in a multi-environment project (#1221)", () => {
  test("rule metadata", () => {
    expect(cor021EnvLiteralNameRule.id).toBe("COR021");
    expect(cor021EnvLiteralNameRule.severity).toBe("warning");
    expect(cor021EnvLiteralNameRule.category).toBe("correctness");
  });

  test("flags a bare string literal in a *Name property", () => {
    const ctx = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      MULTI_ENV_PARAM_BOUND,
    );
    const diags = cor021EnvLiteralNameRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR021");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain('"billing-uploads"');
    expect(diags[0].message).toContain("params.env");
  });

  test("flags a bare `name` property, nested objects included", () => {
    const ctx = createContext(
      `export const svc = new Service({ metadata: { name: "web" } });`,
      MULTI_ENV_PARAM_BOUND,
    );
    const diags = cor021EnvLiteralNameRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('name: "web"');
  });

  test("flags a no-substitution template literal the same as a string literal", () => {
    const ctx = createContext(
      "export const uploads = new Bucket({ bucketName: `billing-uploads` });",
      MULTI_ENV_PARAM_BOUND,
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(1);
  });

  test("passes a template literal interpolating the env parameter", () => {
    const ctx = createContext(
      "export const uploads = new Bucket({ bucketName: `billing-${params.env}-uploads` });",
      MULTI_ENV_PARAM_BOUND,
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(0);
  });

  test("passes non-name properties and non-literal name values", () => {
    const ctx = createContext(
      `
        const shared = { prefix: "billing" };
        export const uploads = new Bucket({ bucketName: shared.prefix, region: "us-east-1" });
      `,
      MULTI_ENV_PARAM_BOUND,
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(0);
  });

  test("silent when ownership.env is a literal", () => {
    const ctx = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      { environments: ["dev", "prod"], ownership: { stack: "billing", env: "prod" } },
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(0);
  });

  test("silent when ownership.env is absent", () => {
    const ctx = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      { environments: ["dev", "prod"], ownership: { stack: "billing" } },
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(0);
  });

  test("silent with fewer than two declared environments", () => {
    const oneEnv = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      { environments: ["prod"], ownership: { stack: "billing", env: { param: "env" } } },
    );
    expect(cor021EnvLiteralNameRule.check(oneEnv)).toHaveLength(0);

    const noEnvs = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      { ownership: { stack: "billing", env: { param: "env" } } },
    );
    expect(cor021EnvLiteralNameRule.check(noEnvs)).toHaveLength(0);
  });

  test("silent without a project config on the context", () => {
    const ctx = createContext(`export const uploads = new Bucket({ bucketName: "billing-uploads" });`);
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(0);
  });

  test("names the bound parameter, whatever it is called", () => {
    const ctx = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      { environments: ["dev", "prod"], ownership: { stack: "billing", env: { param: "stage" } } },
    );
    const diags = cor021EnvLiteralNameRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("params.stage");
  });

  test("object-form environments entries count toward the threshold", () => {
    const ctx = createContext(
      `export const uploads = new Bucket({ bucketName: "billing-uploads" });`,
      {
        environments: ["prod", { name: "floci", endpoint: "http://localhost:4566" }],
        ownership: { stack: "billing", env: { param: "env" } },
      },
    );
    expect(cor021EnvLiteralNameRule.check(ctx)).toHaveLength(1);
  });
});
