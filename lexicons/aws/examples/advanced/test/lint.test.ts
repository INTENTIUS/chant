import { describe, it, expect } from "bun:test";
import * as ts from "typescript";
import { apiTimeoutRule } from "../src/lint/api-timeout";
import type { LintContext } from "@intentius/chant/lint/rule";

function createLintContext(sourceCode: string): LintContext {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  return {
    sourceFile,
    entities: [],
    filePath: "test.ts",
    lexicon: "aws",
  };
}

describe("WAW012: API Gateway Lambda Timeout", () => {
  it("should pass when timeout is 29 seconds", () => {
    const code = `
      const api = LambdaApi({
        name: "test",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 29,
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(0);
  });

  it("should pass when timeout is less than 29 seconds", () => {
    const code = `
      const api = LambdaApi({
        name: "test",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 25,
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(0);
  });

  it("should pass when timeout is not specified", () => {
    const code = `
      const api = LambdaApi({
        name: "test",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(0);
  });

  it("should fail when timeout exceeds 29 seconds", () => {
    const code = `
      const api = LambdaApi({
        name: "test",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 30,
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].ruleId).toBe("WAW012");
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toContain("30");
    expect(diagnostics[0].message).toContain("29");
  });

  it("should fail when timeout is significantly over 29 seconds", () => {
    const code = `
      const badApi = LambdaApi({
        name: "bad",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 60,
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].ruleId).toBe("WAW012");
    expect(diagnostics[0].severity).toBe("error");
  });

  it("should detect violations in preset calls", () => {
    const code = `
      const api1 = SecureApi({
        name: "api1",
        timeout: 30,
      });

      const api2 = HighMemoryApi({
        name: "api2",
        timeout: 35,
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(2);
    expect(diagnostics[0].message).toContain("30");
    expect(diagnostics[1].message).toContain("35");
  });

  it("should detect multiple violations in one file", () => {
    const code = `
      const api1 = LambdaApi({
        name: "api1",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 30,
      });

      const api2 = LambdaApi({
        name: "api2",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 35,
      });

      const api3 = LambdaApi({
        name: "api3",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        timeout: 25, // Valid
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(2);
    expect(diagnostics[0].message).toContain("30");
    expect(diagnostics[1].message).toContain("35");
  });

  it("should not flag non-API-factory calls", () => {
    const code = `
      const func = new Function({
        functionName: "test",
        runtime: "nodejs20.x",
        handler: "index.handler",
        code: { zipFile: "..." },
        role: "arn:aws:iam::123456789012:role/test",
        timeout: 300, // Valid for raw Lambda (up to 900s)
      });
    `;

    const diagnostics = apiTimeoutRule.check(createLintContext(code));
    expect(diagnostics.length).toBe(0);
  });
});
