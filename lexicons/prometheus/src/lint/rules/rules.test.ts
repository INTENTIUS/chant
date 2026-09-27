import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { literalCredentialRule } from "./literal-credential";
import { promqlLiteralRule } from "./promql-literal";

function ctx(code: string): LintContext {
  const sourceFile = ts.createSourceFile("alerts.ts", code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: "alerts.ts" };
}

describe("PROM001 literal credential", () => {
  test("flags literal secrets in a Receiver, at any depth", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        new Receiver({
          name: "oncall",
          slack_configs: [{ api_url: "https://hooks.slack.com/services/T/B/X", channel: "#a" }],
          pagerduty_configs: [{ routing_key: "abc123" }],
          webhook_configs: [{ url: "http://hook", http_config: { authorization: { credentials: "tok" } } }],
        });
      `),
    );
    expect(diags.map((d) => d.ruleId)).toEqual(["PROM001", "PROM001", "PROM001"]);
    expect(diags[0].message).toContain("api_url_file");
    expect(diags[0].line).toBe(4);
  });

  test("flags the global SMTP password in AlertmanagerSettings", () => {
    const diags = literalCredentialRule.check(ctx(`new AlertmanagerSettings({ global: { smtp_auth_password: "hunter2" } });`));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("smtp_auth_password_file");
  });

  test("accepts *_file fields, non-literals, webhook urls and other classes", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        const key = process.env.KEY!;
        new Receiver({ name: "a", pagerduty_configs: [{ routing_key_file: "/etc/pd" }, { routing_key: key }] });
        new Receiver({ name: "b", webhook_configs: [{ url: "http://sink:8080/" }] });
        new Something({ routing_key: "literal" });
      `),
    );
    expect(diags).toEqual([]);
  });
});

describe("PROM002 PromQL literal", () => {
  test("flags a literal expr that does not parse", () => {
    const diags = promqlLiteralRule.check(
      ctx(`
        new RuleGroup({ name: "g", rules: [
          { record: "a:b", expr: "sum(rate(x[5m])" },
          { alert: "A", expr: \`up == 0\` },
        ] });
      `),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("PROM002");
    expect(diags[0].line).toBe(3);
  });

  test("ignores built expressions and exprs outside a RuleGroup", () => {
    const diags = promqlLiteralRule.check(
      ctx(`
        const w = "5m";
        new RuleGroup({ name: "g", rules: [{ record: "a:b", expr: \`rate(x[\${w}])\` }] });
        const notARule = { expr: "(((" };
      `),
    );
    expect(diags).toEqual([]);
  });
});
