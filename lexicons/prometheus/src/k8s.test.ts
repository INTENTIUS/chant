import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { InhibitRule, Receiver, Route, TimeInterval } from "./alertmanager";
import {
  NOTIFIERS,
  alertmanagerConfigInhibitRules,
  alertmanagerConfigMuteTimeIntervals,
  alertmanagerConfigReceivers,
  alertmanagerConfigRoute,
  matcherString,
  notifierKey,
  snakeCase,
  type FieldSpec,
} from "./k8s";

/** The interface of integrations.ts a notifier list is typed by, and the property names it declares. */
function interfaceFields(source: string, name: string): Set<string> {
  const m = new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!m) throw new Error(`no interface ${name}`);
  return new Set([...m[1].matchAll(/^ {2}([a-z_0-9]+)\??:/gm)].map((x) => x[1]));
}

describe("snakeCase", () => {
  test("turns the operator's spellings into Alertmanager's", () => {
    expect(snakeCase("groupBy")).toBe("group_by");
    expect(snakeCase("apiURL")).toBe("api_url");
    expect(snakeCase("forceImplicitTLS")).toBe("force_implicit_tls");
    expect(snakeCase("messageThreadID")).toBe("message_thread_id");
    expect(snakeCase("okText")).toBe("ok_text");
    expect(snakeCase("slackConfigs")).toBe("slack_configs");
  });
});

describe("the converted notifier fields are fields of the declarations' types", () => {
  const source = readFileSync(join(import.meta.dirname, "integrations.ts"), "utf-8");
  const interfaces: Record<string, string> = {
    slackConfigs: "SlackConfig",
    webhookConfigs: "WebhookConfig",
    pagerdutyConfigs: "PagerDutyConfig",
    emailConfigs: "EmailConfig",
    opsgenieConfigs: "OpsGenieConfig",
    pushoverConfigs: "PushoverConfig",
    telegramConfigs: "TelegramConfig",
    webexConfigs: "WebexConfig",
    discordConfigs: "DiscordConfig",
  };
  const nested: Record<string, string> = { fields: "", actions: "SlackAction", responders: "OpsGenieResponder" };

  test("every notifier is covered", () => {
    expect(Object.keys(NOTIFIERS).sort()).toEqual(Object.keys(interfaces).sort());
  });

  for (const [key, type] of Object.entries(interfaces)) {
    test(`${key} fields exist on ${type}`, () => {
      const fields = interfaceFields(source, type);
      // Each notifier's own interface extends NotifierBase (send_resolved).
      fields.add("send_resolved");
      const check = (spec: FieldSpec, known: Set<string>, where: string) => {
        for (const f of spec.plain) expect(known.has(snakeCase(f)), `${where}.${f} -> ${snakeCase(f)}`).toBe(true);
        for (const [k, sub] of Object.entries(spec.lists ?? {})) {
          expect(known.has(snakeCase(k)), `${where}.${k}`).toBe(true);
          if (nested[k]) check(sub, interfaceFields(source, nested[k]), `${where}.${k}`);
        }
      };
      check(NOTIFIERS[key], fields, key);
    });
  }
});

describe("matchers", () => {
  test("a matcher object is a matcher string, with the value quoted", () => {
    expect(matcherString({ name: "severity", value: "critical", matchType: "=" })).toBe('severity="critical"');
    expect(matcherString({ name: "job", value: 'a"b\\c', matchType: "!~" })).toBe('job!~"a\\"b\\\\c"');
    expect(matcherString({ name: "x", value: "", matchType: "!=" })).toBe('x!=""');
  });

  test("one that has no string form that reads back the same has none", () => {
    expect(matcherString({ name: "x", value: "y" })).toBeUndefined();
    expect(matcherString({ name: "x", value: "y", matchType: "=", regex: true })).toBeUndefined();
    expect(matcherString({ name: "not a label", value: "y", matchType: "=" })).toBeUndefined();
    expect(matcherString({ name: "x", matchType: "=" })).toBeUndefined();
    expect(matcherString({ name: "x", value: "y", matchType: "==" })).toBeUndefined();
  });
});

describe("declarations back to the CRD", () => {
  const weekends = new TimeInterval({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"], days_of_month: ["1:5", "-1"], times: [{ start_time: "00:00", end_time: "06:00" }] }] });
  const pager = new Receiver({ name: "pager", pagerduty_configs: [{ severity: "critical", client_url: "https://example.com" }] });

  test("a route: receiver and intervals by name, matchers as objects, children recursive", () => {
    const route = new Route({
      receiver: pager,
      group_by: ["alertname"],
      group_wait: "30s",
      matchers: ['team=~"a|b"'],
      mute_time_intervals: [weekends],
      routes: [{ receiver: "other", continue: true, matchers: ['env!="dev", job="x"'] }, new Route({ receiver: "x" })],
    });
    expect(alertmanagerConfigRoute(route)).toEqual({
      receiver: "pager",
      groupBy: ["alertname"],
      groupWait: "30s",
      matchers: [{ name: "team", value: "a|b", matchType: "=~" }],
      muteTimeIntervals: ["weekends"],
      routes: [
        {
          receiver: "other",
          matchers: [
            { name: "env", value: "dev", matchType: "!=" },
            { name: "job", value: "x", matchType: "=" },
          ],
          continue: true,
        },
        { receiver: "x" },
      ],
    });
  });

  test("a route field the CRD has no word for is an error naming it", () => {
    expect(() => alertmanagerConfigRoute(new Route({ receiver: "a", labels: { team: "x" } }))).toThrow(/labels cannot be written/);
    expect(() => alertmanagerConfigRoute(new Route({ matchers: ["nonsense"] }))).toThrow(/route: .*operator/);
  });

  test("receivers: camel case again, and the kept fields merged in entry by entry", () => {
    const slack = new Receiver({
      name: "slack",
      slack_configs: [{ channel: "#a", send_resolved: true, icon_url: "u", actions: [{ type: "button", text: "t", url: "u", confirm: { text: "c", ok_text: "Yes" } }] }, { channel: "#b" }],
    });
    const kept = { slack: { slackConfigs: [{ apiURL: { name: "s", key: "url" } }] }, pager: { webhookConfigs: [{ url: "x" }] } };
    expect(alertmanagerConfigReceivers([slack, pager], kept)).toEqual([
      {
        name: "slack",
        slackConfigs: [
          { channel: "#a", sendResolved: true, iconURL: "u", actions: [{ type: "button", text: "t", url: "u", confirm: { text: "c", okText: "Yes" } }], apiURL: { name: "s", key: "url" } },
          { channel: "#b" },
        ],
      },
      { name: "pager", pagerdutyConfigs: [{ severity: "critical", clientURL: "https://example.com" }], webhookConfigs: [{ url: "x" }] },
    ]);
  });

  test("a receiver with something the CRD cannot say is an error naming it", () => {
    expect(() => alertmanagerConfigReceivers([new Receiver({ name: "a", labels: { x: "y" } })])).toThrow(/labels cannot be written/);
    expect(() => alertmanagerConfigReceivers([new Receiver({ name: "a", jira_configs: [{}] as never })])).toThrow(/jira_configs cannot be written/);
    expect(() => alertmanagerConfigReceivers([new Receiver({ name: "a", slack_configs: [{ api_url: "u" }] })])).toThrow(/api_url cannot be written/);
  });

  test("inhibit rules and time intervals", () => {
    expect(alertmanagerConfigInhibitRules([new InhibitRule({ source_matchers: ['a="1"'], target_matchers: ['a="2"'], equal: ["x"] })])).toEqual([
      { sourceMatch: [{ name: "a", value: "1", matchType: "=" }], targetMatch: [{ name: "a", value: "2", matchType: "=" }], equal: ["x"] },
    ]);
    expect(() => alertmanagerConfigInhibitRules([new InhibitRule({ name: "n", equal: [] })])).toThrow(/name cannot be written/);
    expect(alertmanagerConfigMuteTimeIntervals([weekends])).toEqual([
      {
        name: "weekends",
        timeIntervals: [
          { times: [{ startTime: "00:00", endTime: "06:00" }], weekdays: ["saturday", "sunday"], daysOfMonth: [{ start: 1, end: 5 }, { start: -1, end: -1 }] },
        ],
      },
    ]);
    expect(() => alertmanagerConfigMuteTimeIntervals([new TimeInterval({ name: "t", time_intervals: [{ location: "Europe/Berlin" }] })])).toThrow(/location cannot be written/);
  });

  test("the notifier key is Alertmanager's", () => {
    expect(notifierKey("pagerdutyConfigs")).toBe("pagerduty_configs");
  });
});
