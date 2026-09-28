import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { literalCredentialRule } from "./literal-credential";
import { promqlLiteralRule } from "./promql-literal";
import { sloLiteralRule } from "./slo-literal";

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

describe("PROM003 Slo literal", () => {
  test("flags an objective outside (0, 1), a bad window and a broken SLI, at the literal", () => {
    const diags = sloLiteralRule.check(
      ctx(`
        export const a = Slo({
          name: "a",
          objective: 99.5,
          window: "4 weeks",
          sli: { good: "sum(rate(ok_total[5m]))", total: "sum(rate(all_total[{{window}}])" },
        });
        export const b = Slo({ name: "b", objective: -1, window: "0", sli: { errors: "sum(rate(e[{{window}}]))", total: "sum(rate(t[{{window}}]))" } });
      `),
    );
    expect(diags.map((d) => [d.ruleId, d.line])).toEqual([
      ["PROM003", 4],
      ["PROM003", 5],
      ["PROM003", 6],
      ["PROM003", 6],
      ["PROM003", 8],
      ["PROM003", 8],
    ]);
    expect(diags[0].message).toContain("strictly between 0 and 1");
    expect(diags[1].message).toContain("positive Prometheus duration");
    expect(diags[2].message).toContain("{{window}}");
    expect(diags[3].message).toContain("not valid PromQL");
  });

  test("accepts a valid Slo, values built at runtime, and other callees", () => {
    const diags = sloLiteralRule.check(
      ctx(`
        const objective = 1.5;
        Slo({ name: "a", objective: 0.999, window: "30d", sli: { good: \`sum(rate(ok[{{window}}]))\`, total: "sum(rate(all[{{window}}]))" } });
        Slo({ name: "b", objective, window: process.env.W!, sli: { good: expr, total: expr } });
        Other({ objective: 5, window: "nope" });
      `),
    );
    expect(diags).toEqual([]);
  });
});
