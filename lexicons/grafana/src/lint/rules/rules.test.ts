import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { uidSyntaxRule } from "./uid-syntax";
import { literalSecretRule } from "./literal-secret";

function ctx(code: string): LintContext {
  const sourceFile = ts.createSourceFile("dashboard.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "dashboard.ts" };
}

describe("GRAF001 uid and variable-name syntax", () => {
  test("flags an over-long or ill-formed uid and an unusable variable name", () => {
    const diags = uidSyntaxRule.check(
      ctx(`
        new Dashboard({ title: "x", uid: "${"a".repeat(41)}" });
        new Datasource({ name: "P", type: "prometheus", uid: "has space" });
        new QueryVariable({ name: "my-var", datasource: p, query: "q" });
        new CustomVariable({ name: "1st", values: [] });
      `),
    );
    expect(diags.map((d) => [d.ruleId, d.line])).toEqual([
      ["GRAF001", 2],
      ["GRAF001", 3],
      ["GRAF001", 4],
      ["GRAF001", 5],
    ]);
  });

  test("follows a props object declared as a const", () => {
    const diags = uidSyntaxRule.check(ctx(`const props = { title: "x", uid: "bad/uid" };\nnew Dashboard(props);`));
    expect(diags).toHaveLength(1);
  });

  test("accepts valid values, non-literals and other constructors", () => {
    const diags = uidSyntaxRule.check(
      ctx(`
        new Dashboard({ title: "x", uid: "svc-overview_1" });
        new Dashboard({ title: "x", uid: someUid });
        new TextboxVariable({ name: "trace_id" });
        new Deployment({ uid: "not grafana at all" });
      `),
    );
    expect(diags).toEqual([]);
  });
});

describe("GRAF002 literal secret", () => {
  test("flags a literal in secureJsonData, inline or through a const", () => {
    const diags = literalSecretRule.check(
      ctx(`
        new Datasource({ name: "P", type: "prometheus", secureJsonData: { basicAuthPassword: "hunter2" } });
        const secrets = { httpHeaderValue1: "Bearer abc" };
        new Datasource({ name: "T", type: "tempo", secureJsonData: secrets });
      `),
    );
    expect(diags.map((d) => d.ruleId)).toEqual(["GRAF002", "GRAF002"]);
    expect(diags[0].message).toContain("basicAuthPassword");
  });

  test("accepts values Grafana expands and other constructors", () => {
    const diags = literalSecretRule.check(
      ctx(`
        new Datasource({ name: "P", type: "prometheus", secureJsonData: { a: "$__env{PROM_PASSWORD}", b: "$__file{/run/secrets/token}", c: "\${TOKEN}", d: "$TOKEN" } });
        new Secret({ secureJsonData: { password: "not ours" } });
      `),
    );
    expect(diags).toEqual([]);
  });
});
