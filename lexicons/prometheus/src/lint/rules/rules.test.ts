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

  test("follows values lifted into named consts, shorthand props and spreads", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        const heartbeatEmail: EmailConfig[] = [{ to: "a@example.com", auth_password: "hunter2" }];
        const heartbeat = new Receiver({ name: "heartbeat", email_configs: heartbeatEmail });
        const oncallUntyped = { opsgenie_configs: [{ api_key: "x" }], pagerduty_configs: [{ service_key: "k" }] };
        const oncall = new Receiver({ name: "oncall", ...oncallUntyped });
        const global: AlertmanagerGlobalConfig = { smtp_auth_password: "p" };
        const settings = new AlertmanagerSettings({ global });
        const safe: PagerDutyConfig[] = [{ routing_key_file: "/etc/pd" }];
        const pager = new Receiver({ name: "pager", pagerduty_configs: safe });
      `),
    );
    expect(diags.map((d) => d.message.split("`")[1])).toEqual(["auth_password", "api_key", "service_key", "smtp_auth_password"]);
  });

  test("covers every integration's credential, and api_url and routing_key only where they are one", () => {
    const diags = literalCredentialRule.check(
      ctx(`
        const chatSlack: SlackConfig[] = [{ api_url: "https://hooks.slack.com/services/T/B/X", app_token: "xoxb-1" }];
        new Receiver({
          name: "chat",
          slack_configs: chatSlack,
          discord_configs: [{ webhook_url: "https://discord.com/api/webhooks/1/x" }],
          telegram_configs: [{ bot_token: "123:abc", chat_id: 1 }],
          webex_configs: [{ api_url: "https://webexapis.com/v1/messages", room_id: "r" }],
          victorops_configs: [{ api_key: "k", routing_key: "ops" }],
          pushover_configs: [{ user_key: "u", token: "t" }],
          rocketchat_configs: [{ token_id: "i", token_file: "/etc/rc" }],
        });
        new AlertmanagerSettings({ global: { telegram_bot_token: "123:abc", webex_api_url: "https://webexapis.com/v1/messages" } });
      `),
    );
    expect(diags.map((d) => d.message.split("`")[1])).toEqual([
      "api_url",
      "app_token",
      "webhook_url",
      "bot_token",
      "api_key",
      "user_key",
      "token",
      "token_id",
      "telegram_bot_token",
    ]);
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

  test("follows rules lifted into a named const", () => {
    const diags = promqlLiteralRule.check(
      ctx(`
        const apiRules: Rule[] = [{ record: "a:b", expr: "sum(" }, { alert: "A", expr: "up == 0" }];
        const api = new RuleGroup({ name: "api", rules: apiRules });
        const rules: Rule[] = [{ record: "c:d", expr: "rate(x[5m]" }];
        const other = new RuleGroup({ name: "other", rules });
      `),
    );
    expect(diags.map((d) => d.line)).toEqual([2, 4]);
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
