/**
 * promtool and amtool, over output the lexicon builds. Each test runs the
 * real binary when it is on PATH (or named by $PROMTOOL / $AMTOOL) and skips
 * otherwise; the structural checks in post-synth.test.ts always run.
 */
import { describe, expect, test } from "vitest";
import {
  AlertmanagerSettings,
  InhibitRule,
  Receiver,
  Route,
  RuleGroup,
  TimeInterval,
  alertmanagerYaml,
  amtoolCheckConfig,
  hasTool,
  promtoolCheckRules,
  ruleFileYaml,
} from "./index";
import { INTEGRATION_CASES, amWith } from "./testdata/integration-cases";

const PROMTOOL = process.env.PROMTOOL ?? "promtool";
const AMTOOL = process.env.AMTOOL ?? "amtool";
const hasPromtool = hasTool(PROMTOOL);
const hasAmtool = hasTool(AMTOOL);

function groups() {
  return [
    new RuleGroup({
      name: "api",
      interval: "30s",
      query_offset: "1m",
      labels: { team: "api" },
      rules: [
        {
          record: "job:http_errors:ratio5m",
          expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m]))\n  / sum by (job) (rate(http_requests_total[5m]))',
        },
        {
          alert: "ApiErrors",
          expr: "job:http_errors:ratio5m > 0.05",
          for: "10m",
          keep_firing_for: "5m",
          labels: { severity: "page" },
          annotations: { summary: "{{ $labels.job }} 5xx ratio is {{ $value | humanizePercentage }}" },
        },
        { alert: "ApiErrors", expr: "job:http_errors:ratio5m > 0.01", for: "1h", labels: { severity: "ticket" }, annotations: { summary: "x: y" } },
      ],
    }),
    new RuleGroup({ name: "limits", limit: 10, rules: [{ alert: "TooMany", expr: "count(up) > 100", labels: { severity: "ticket" } }] }),
  ];
}

function alertmanager() {
  const oncall = new Receiver({
    name: "oncall",
    pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/pd", severity: "critical" }],
    slack_configs: [{ api_url_file: "/etc/alertmanager/slack", channel: "#alerts", send_resolved: true }],
  });
  const mail = new Receiver({
    name: "mail",
    email_configs: [{ to: "team@example.com", auth_username: "am", auth_password_file: "/etc/alertmanager/smtp" }],
  });
  const sink = new Receiver({ name: "default", webhook_configs: [{ url: "http://sink:8080/", max_alerts: 10, timeout: "10s" }] });
  const weekend = new TimeInterval({
    name: "weekend",
    time_intervals: [{ weekdays: ["saturday", "sunday"] }, { times: [{ start_time: "18:00", end_time: "24:00" }], location: "Europe/Berlin" }],
  });
  return [
    new AlertmanagerSettings({ global: { resolve_timeout: "5m", smtp_smarthost: "smtp.example.com:587", smtp_from: "am@example.com" } }),
    new Route({
      receiver: sink,
      group_by: ["alertname", "job"],
      group_wait: "30s",
      group_interval: "5m",
      repeat_interval: "4h",
      routes: [
        { matchers: ['severity="page"'], receiver: oncall, continue: true },
        { matchers: ['severity=~"ticket|info"'], receiver: mail, mute_time_intervals: [weekend] },
      ],
    }),
    new InhibitRule({ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["alertname"] }),
  ];
}

describe("promtool check rules", () => {
  test.skipIf(!hasPromtool)("accepts the rule file the lexicon builds", () => {
    const r = promtoolCheckRules(ruleFileYaml(groups()), PROMTOOL);
    expect(r.ran).toBe(true);
    expect(r.output).toContain("SUCCESS");
    expect(r.ok).toBe(true);
  });

  test.skipIf(!hasPromtool)("rejects what PROM101 flags, so the two agree", () => {
    const [g] = groups();
    const r = promtoolCheckRules(ruleFileYaml([g, new RuleGroup({ name: "api", rules: [] })]), PROMTOOL);
    expect(r.ok).toBe(false);
  });

  test("reports ran: false when the binary is missing", () => {
    expect(promtoolCheckRules("groups: []\n", "/nonexistent/promtool")).toEqual({ ran: false, ok: false, output: "" });
  });
});

describe("amtool check-config", () => {
  test.skipIf(!hasAmtool)("accepts the alertmanager.yml the lexicon builds", () => {
    const r = amtoolCheckConfig(alertmanagerYaml(alertmanager()), AMTOOL);
    expect(r.ran).toBe(true);
    expect(r.ok, r.output).toBe(true);
  });

  test.skipIf(!hasAmtool)("rejects what PROM201 flags, so the two agree", () => {
    const r = amtoolCheckConfig(alertmanagerYaml([new Route({ receiver: "nobody" })]), AMTOOL);
    expect(r.ok).toBe(false);
  });

  test.skipIf(!hasAmtool).each(INTEGRATION_CASES.filter((c) => c[4].length > 0))("rejects what PROM208-PROM210 flag: %s", (_label, key, entry, global) => {
    const r = amtoolCheckConfig(amWith(key, entry, global), AMTOOL);
    expect(r.ok, r.output).toBe(false);
  });

  test("reports ran: false when the binary is missing", () => {
    expect(amtoolCheckConfig("route: {}\n", "/nonexistent/amtool").ran).toBe(false);
  });
});
