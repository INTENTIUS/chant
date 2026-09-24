import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { componentIdSyntaxRule } from "./component-id-syntax";
import { literalCredentialRule } from "./literal-credential";

function ctx(code: string): LintContext {
  const sourceFile = ts.createSourceFile("collector.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "collector.ts" };
}

describe("OTEL001 component id syntax", () => {
  test("flags a pipeline string that is not type[/name]", () => {
    const diags = componentIdSyntaxRule.check(
      ctx(`export const t = new Pipeline({ signal: "traces", receivers: ["otlp/"], exporters: ["otlp backend", "debug"] });`),
    );
    expect(diags.map((d) => d.ruleId)).toEqual(["OTEL001", "OTEL001"]);
    expect(diags[0].message).toContain('"otlp/"');
    expect(diags[1].message).toContain('"otlp backend"');
  });

  test("flags an instance name with whitespace, an empty name or a leading slash", () => {
    const diags = componentIdSyntaxRule.check(
      ctx(`
        new OtlpExporter({ name: "my backend", endpoint: "x:4317" });
        new DebugExporter({ name: "" });
        new BatchProcessor({ name: "/fast" });
      `),
    );
    expect(diags).toHaveLength(3);
    expect(diags[0].line).toBe(2);
  });

  test("accepts ids, names, entity references and non-literal values", () => {
    const diags = componentIdSyntaxRule.check(
      ctx(`
        const n = "dynamic";
        new OtlpExporter({ name: "backend", endpoint: "x:4317" });
        new OtlpExporter({ name: n, endpoint: "x:4317" });
        new Pipeline({ signal: "traces", receivers: [otlp, "otlp/edge"], processors: ["batch"], exporters: ["otlp/backend"] });
        new Deployment({ name: "not otel at all" });
      `),
    );
    expect(diags).toEqual([]);
  });
});

describe("OTEL002 literal credential", () => {
  test("flags literal credentials in headers and nested keys", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        new OtlpHttpExporter({ endpoint: "https://api.example", headers: { authorization: "Bearer abc123", "x-api-key": "k" } });
        new DatadogExporter({ api: { key: "x", api_key: "literal" } });
      `),
    );
    expect(diags.map((d) => d.ruleId)).toEqual(["OTEL002", "OTEL002", "OTEL002"]);
    expect(diags[0].message).toContain("authorization");
  });

  test("accepts env and file references, *_file paths, and non-component constructors", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        new OtlpExporter({ endpoint: "x:4317", headers: { authorization: "Bearer \${env:TOKEN}" } });
        new OtlpExporter({ endpoint: "x:4317", tls: { key_file: "/etc/tls/key.pem", cert_file: "/etc/tls/cert.pem" } });
        new Secret({ password: "not ours to judge" });
      `),
    );
    expect(diags).toEqual([]);
  });
});
