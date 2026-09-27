import { describe, expect, test } from "vitest";
import { makePostSynthCtx, makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import { postSynthChecks } from "./index";
import { prom101 } from "./prom101";
import { prom102 } from "./prom102";
import { prom103 } from "./prom103";
import { prom104 } from "./prom104";
import { prom105 } from "./prom105";
import { prom106 } from "./prom106";
import { prom107 } from "./prom107";
import { prom201 } from "./prom201";
import { prom202 } from "./prom202";
import { prom203 } from "./prom203";
import { prom204 } from "./prom204";
import { prom205 } from "./prom205";
import { prom206 } from "./prom206";
import { prom207 } from "./prom207";
import { prom208 } from "./prom208";
import { prom209 } from "./prom209";

const RULES = `groups:
  - name: api
    interval: 30s
    rules:
      - record: job:http_errors:ratio5m
        expr: sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))
      - alert: ApiErrors
        expr: job:http_errors:ratio5m > 0.05
        for: 10m
        labels:
          severity: page
        annotations:
          summary: errors
      - alert: ApiErrors
        expr: job:http_errors:ratio5m > 0.01
        for: 1h
        labels:
          severity: ticket
        annotations:
          summary: errors
`;

const AM = `global:
  resolve_timeout: 5m
route:
  receiver: default
  group_by: [alertname]
  routes:
    - receiver: oncall
      matchers: ['severity="page"']
    - receiver: default
      matchers: ['severity=~"ticket|info"']
      mute_time_intervals: [weekend]
inhibit_rules:
  - source_matchers: ['severity="page"']
    target_matchers: ['severity="ticket"']
    equal: [alertname]
receivers:
  - name: default
    webhook_configs:
      - url: "http://sink:8080/"
  - name: oncall
    pagerduty_configs:
      - routing_key_file: /etc/pd
time_intervals:
  - name: weekend
    time_intervals:
      - weekdays: [saturday, sunday]
`;

const both = (rules = RULES, am = AM) => makePostSynthCtxFromFiles("prometheus", { "alertmanager.yml": am }, rules);
const rulesOnly = (rules: string) => makePostSynthCtx("prometheus", rules);
const amOnly = (am: string) => makePostSynthCtx("prometheus", am);

describe("a clean rule file and alertmanager.yml", () => {
  test.each(postSynthChecks.map((c) => [c.id, c] as const))("%s finds nothing", (_id, check) => {
    expect(check.check(both())).toEqual([]);
  });
});

describe("rule file checks", () => {
  test("PROM101 repeated group name", () => {
    const diags = prom101.check(rulesOnly(`${RULES}  - name: api\n    rules: []\n`));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "PROM101", severity: "error", entity: "api" });
  });

  test("PROM102 same name and labels, but not same name with a different severity", () => {
    const dup = RULES.replace("severity: ticket", "severity: page");
    expect(prom102.check(rulesOnly(dup)).map((d) => d.entity)).toEqual(["api/ApiErrors"]);
    expect(prom102.check(rulesOnly(RULES))).toEqual([]);
  });

  test("PROM102 counts group labels", () => {
    const text = `groups:
  - name: a
    labels: {team: x}
    rules:
      - record: r
        expr: "1"
  - name: b
    rules:
      - record: r
        expr: "1"
        labels: {team: x}
`;
    expect(prom102.check(rulesOnly(text))).toHaveLength(1);
  });

  test("PROM103 bad durations on the group and the rule", () => {
    const bad = RULES.replace("interval: 30s", "interval: 30 seconds").replace("for: 10m", "for: 1.5h");
    expect(prom103.check(rulesOnly(bad)).map((d) => d.message)).toEqual([
      'group "api" interval "30 seconds" is not a Prometheus duration (e.g. 30s, 1m, 1h30m)',
      'rule api/ApiErrors for "1.5h" is not a Prometheus duration (e.g. 5m, 1h)',
    ]);
  });

  test("PROM104 PromQL syntax", () => {
    const bad = RULES.replace("expr: job:http_errors:ratio5m > 0.05", "expr: job:http_errors:ratio5m >");
    const diags = prom104.check(rulesOnly(bad));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("api/ApiErrors");
    expect(diags[0].message).toContain("ends early");
  });

  test("PROM105 malformed rules", () => {
    const text = `groups:
  - name: g
    rules:
      - record: a:b
        expr: "1"
        for: 5m
      - expr: "1"
      - record: x
        alert: y
        expr: "1"
`;
    const diags = prom105.check(rulesOnly(text));
    expect(diags.map((d) => d.message)).toEqual([
      "recording rule g/a:b sets for, which only alerting rules take",
      "rule g/rule 2 sets neither record nor alert",
      "rule g/x sets both record and alert; a rule is one or the other",
    ]);
  });

  test("PROM106 no severity, unless the group carries one", () => {
    const noSev = RULES.replace("        labels:\n          severity: page\n", "");
    expect(prom106.check(rulesOnly(noSev)).map((d) => d.entity)).toEqual(["api/ApiErrors"]);
    const groupSev = noSev.replace("    interval: 30s\n", "    interval: 30s\n    labels:\n      severity: page\n");
    expect(prom106.check(rulesOnly(groupSev))).toEqual([]);
  });

  test("PROM107 no summary or description", () => {
    const bare = RULES.replace("        annotations:\n          summary: errors\n", "");
    expect(prom107.check(rulesOnly(bare))).toHaveLength(1);
  });
});

describe("alertmanager checks", () => {
  test("PROM201 route to an undeclared receiver", () => {
    const diags = prom201.check(amOnly(AM.replace("  - receiver: oncall", "  - receiver: on-call")));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('receiver "on-call"');
    expect(diags[0].entity).toBe("route.routes[0]");
  });

  test("PROM202 an alert severity no route matches", () => {
    const rules = RULES.replace("severity: ticket", "severity: warning");
    const diags = prom202.check(both(rules));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "PROM202", severity: "warning", entity: "warning" });
    expect(diags[0].message).toContain("api/ApiErrors");
  });

  test("PROM202 reads regexes and negative matchers, and nested routes", () => {
    const am = AM.replace(`    - receiver: default
      matchers: ['severity=~"ticket|info"']
      mute_time_intervals: [weekend]`, `    - receiver: default
      matchers: ['team="x"']
      routes:
        - receiver: default
          matchers: ['severity!="page"']`);
    expect(prom202.check(both(RULES, am))).toEqual([]);
  });

  test("PROM202 is silent without rules or without an alertmanager config (chant #1939)", () => {
    expect(prom202.check(rulesOnly(RULES.replace("severity: ticket", "severity: nope")))).toEqual([]);
    expect(prom202.check(amOnly(AM))).toEqual([]);
  });

  test("PROM203 repeated receiver and interval names", () => {
    const dup = AM.replace("time_intervals:\n  - name: weekend", "time_intervals:\n  - name: weekend\n    time_intervals: []\n  - name: weekend") + "  - name: default\n";
    const am = dup.replace("receivers:\n", "receivers:\n  - name: oncall\n");
    const diags = prom203.check(amOnly(am));
    expect(diags.map((d) => d.entity).sort()).toEqual(["oncall", "weekend"]);
  });

  test("PROM204 an undeclared time interval", () => {
    const diags = prom204.check(amOnly(AM.replace("mute_time_intervals: [weekend]", "mute_time_intervals: [weekends]")));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"weekends"');
  });

  test("PROM205 root route shape", () => {
    expect(prom205.check(amOnly("receivers:\n  - name: a\n")).map((d) => d.message)[0]).toContain("no root route");
    expect(prom205.check(amOnly(AM.replace("  receiver: default\n  group_by", "  group_by")))[0].message).toContain("no receiver");
    expect(prom205.check(amOnly(AM.replace("  group_by: [alertname]", "  group_by: [alertname]\n  matchers: ['a=\"b\"']")))[0].message).toContain(
      "has matchers",
    );
  });

  test("PROM206 unparseable matchers in routes and inhibit rules", () => {
    const bad = AM.replace(`matchers: ['severity="page"']`, `matchers: ['severity']`).replace(
      `target_matchers: ['severity="ticket"']`,
      `target_matchers: ['severity=~"("']`,
    );
    expect(prom206.check(amOnly(bad)).map((d) => d.entity)).toEqual(["route.routes[0]", "inhibit_rules[0]"]);
  });

  test("PROM207 an unused receiver", () => {
    const diags = prom207.check(amOnly(`${AM.replace("\ntime_intervals:", "\n  - name: spare\ntime_intervals:")}`));
    expect(diags.map((d) => d.entity)).toEqual(["spare"]);
  });

  test("PROM208 bad Alertmanager durations", () => {
    const bad = AM.replace("resolve_timeout: 5m", "resolve_timeout: five").replace("group_by: [alertname]", "group_by: [alertname]\n  group_wait: 30sec");
    expect(prom208.check(amOnly(bad)).map((d) => d.entity).sort()).toEqual(["global", "route"]);
  });

  test("PROM209 integrations missing their destination", () => {
    const am = `route:
  receiver: all
receivers:
  - name: all
    webhook_configs: [{}]
    slack_configs: [{channel: "#a"}]
    pagerduty_configs: [{}]
    email_configs: [{to: a@b.c}]
`;
    const msgs = prom209.check(amOnly(am)).map((d) => d.message);
    expect(msgs).toHaveLength(5);
    expect(msgs.join("\n")).toContain("smarthost");
    const withGlobals = `global:\n  slack_api_url_file: /etc/slack\n  smtp_smarthost: "smtp:25"\n  smtp_from: am@b.c\n${am}`;
    expect(prom209.check(amOnly(withGlobals)).map((d) => d.message)).toHaveLength(2);
  });
});

describe("documents from other lexicons", () => {
  test("a k8s manifest and a collector config are not read as ours", () => {
    const ctx = makePostSynthCtx(
      "k8s",
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n---\nreceivers:\n  otlp: {}\nservice:\n  pipelines: {}\n`,
    );
    for (const check of postSynthChecks) expect(check.check(ctx)).toEqual([]);
  });
});
