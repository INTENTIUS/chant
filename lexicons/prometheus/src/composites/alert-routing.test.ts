/**
 * `AlertRouting`: the routing tree, the inhibit rules between levels and
 * the receivers it declares, and that the severities `Slo`, `GenAiRules`,
 * `RedAlerts` and `Watchdog` write all find a route (PROM202).
 * `amtool check-config` runs when amtool is on PATH.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { genAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { spanMetricsNames } from "@intentius/chant-lexicon-otel/metric-names";
import { AlertRouting, ALERT_ROUTING_LEVELS, type AlertRoutingProps } from "./alert-routing";
import { Slo } from "./slo";
import { GenAiRules } from "./genai";
import { RedAlerts } from "./red-alerts";
import { Watchdog } from "./watchdog";
import { Receiver, isInhibitRule, isReceiver } from "../alertmanager";
import { alertmanagerYaml, buildAlertmanagerConfig, buildRuleFile } from "../build";
import { validateAlertmanagerConfig, validateSeverityRouting } from "../validate-config";
import { amtoolCheckConfig, hasTool } from "../tools";

const hasAmtool = hasTool(process.env.AMTOOL ?? "amtool");

const values = (...instances: Array<{ members: Record<string, unknown> }>) =>
  instances.flatMap((i) => Object.values(i.members)) as Declarable[];

function built(props: AlertRoutingProps = {}, ...more: Array<{ members: Record<string, unknown> }>) {
  return buildAlertmanagerConfig(values(AlertRouting(props), ...more));
}

const pager = { name: "pager", pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/secrets/pagerduty" }] };
const chat = { name: "chat", slack_configs: [{ api_url_file: "/etc/alertmanager/secrets/slack", channel: "#alerts" }] };

describe("AlertRouting defaults", () => {
  const { config, warnings } = built();

  test("a root route to a default receiver that drops, and one child route per level", () => {
    expect(warnings).toEqual([]);
    expect(config.receivers).toEqual([{ name: "default" }]);
    expect(config.route).toMatchObject({ receiver: "default", group_by: ["alertname"], group_wait: "30s", group_interval: "5m", repeat_interval: "4h" });
    expect(config.route?.routes).toEqual([
      { receiver: "default", matchers: ['severity=~"critical|page"'] },
      { receiver: "default", matchers: ['severity=~"warning|ticket"'] },
      { receiver: "default", matchers: ['severity="info"'] },
    ]);
  });

  test("each level holds back the levels below it, for the same alert", () => {
    const equal = ["alertname", "slo", "service_name", "team"];
    expect(config.inhibit_rules).toEqual([
      { name: "critical holds back warning", source_matchers: ['severity=~"critical|page"'], target_matchers: ['severity=~"warning|ticket"'], equal },
      { name: "critical holds back info", source_matchers: ['severity=~"critical|page"'], target_matchers: ['severity="info"'], equal },
      { name: "warning holds back info", source_matchers: ['severity=~"warning|ticket"'], target_matchers: ['severity="info"'], equal },
    ]);
  });

  test("passes the Alertmanager checks", () => {
    expect(validateAlertmanagerConfig(config)).toEqual([]);
  });

  test("the default levels are the severities the lexicon's composites write", () => {
    expect(ALERT_ROUTING_LEVELS.map((l) => l.severities)).toEqual([["critical", "page"], ["warning", "ticket"], ["info"]]);
  });
});

describe("AlertRouting with the lexicon's alerting composites", () => {
  const slo = Slo({
    name: "checkout",
    objective: 0.995,
    window: "28d",
    sli: {
      good: 'sum(rate(traces_span_metrics_calls_total{span_name="checkout",status_code!="STATUS_CODE_ERROR"}[{{window}}]))',
      total: 'sum(rate(traces_span_metrics_calls_total{span_name="checkout"}[{{window}}]))',
    },
    alerting: { page: { burnRates: "default" }, ticket: { burnRates: "default" } },
  });
  const genai = GenAiRules({ genAi: genAiMetrics(), alerts: { errorRatio: true, latency: { severity: "critical" } } });
  const red = RedAlerts({ spanMetrics: spanMetricsNames({}) });
  const watchdog = Watchdog({});
  const rules = buildRuleFile([slo.rules, genai.rules, red.rules, watchdog.rules]).config;

  test("every severity they write is routed (PROM202), with the watchdog first", () => {
    const am = built({ receiver: chat, levels: [{ ...ALERT_ROUTING_LEVELS[0], receiver: pager }, ...ALERT_ROUTING_LEVELS.slice(1)], routes: [watchdog.route] }, watchdog);
    expect(am.warnings).toEqual([]);
    expect(validateSeverityRouting([rules], am.config)).toEqual([]);
    expect(validateAlertmanagerConfig(am.config)).toEqual([]);
    expect(am.config.route?.routes?.map((r) => r.receiver)).toEqual(["heartbeat", "pager", "chat", "chat"]);
    expect(am.config.receivers?.map((r) => r.name)).toEqual(["chat", "heartbeat", "pager"]);
  });

  test.skipIf(!hasAmtool)("amtool check-config passes", () => {
    const yaml = alertmanagerYaml(values(AlertRouting({ receiver: chat, routes: [watchdog.route] }), watchdog));
    const r = amtoolCheckConfig(yaml);
    expect(r.ran).toBe(true);
    expect(r.ok, r.output).toBe(true);
  });
});

describe("AlertRouting teams", () => {
  test("a route per team before the levels, with a level of its own sent elsewhere", () => {
    const dbPager = { name: "db-pager", pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/secrets/db" }] };
    const { config } = built({
      receiver: chat,
      teams: [{ team: "db", receiver: "db-chat", levels: { critical: dbPager }, repeatInterval: "1h" }],
    });
    expect(config.route?.routes?.[0]).toEqual({
      receiver: "db-chat",
      matchers: ['team="db"'],
      repeat_interval: "1h",
      routes: [{ receiver: "db-pager", matchers: ['severity=~"critical|page"'] }],
    });
    expect(config.route?.routes).toHaveLength(4);
    expect(config.receivers?.map((r) => r.name)).toEqual(["chat", "db-pager"]);
  });

  test("teamLabel changes the label team routes match on, and inhibit equality with it", () => {
    const { config } = built({ teamLabel: "owner", teams: [{ team: "web", receiver: chat }] });
    expect(config.route?.routes?.[0].matchers).toEqual(['owner="web"']);
    expect(config.inhibit_rules?.[0].equal).toEqual(["alertname", "slo", "service_name", "owner"]);
  });
});

describe("AlertRouting options", () => {
  test("levels of your own, timing, group_by, no inhibition", () => {
    const routing = AlertRouting({
      levels: [{ name: "sev1", severities: ["sev1"], receiver: pager, groupWait: "10s" }, { name: "sev2", severities: ["sev2"] }],
      groupBy: ["alertname", "service_name"],
      repeatInterval: "12h",
      inhibit: false,
    });
    expect(Object.values(routing.members).some(isInhibitRule)).toBe(false);
    expect(Object.keys(routing.members).sort()).toEqual(["receiver_default", "receiver_pager", "route"]);
    const { config } = buildAlertmanagerConfig(values(routing));
    expect(config.route).toMatchObject({ group_by: ["alertname", "service_name"], repeat_interval: "12h" });
    expect(config.route?.routes).toEqual([
      { receiver: "pager", matchers: ['severity="sev1"'], group_wait: "10s" },
      { receiver: "default", matchers: ['severity="sev2"'] },
    ]);
    expect(validateAlertmanagerConfig(config)).toEqual([]);
  });

  test("a declared receiver is referenced, not declared again; one props object used twice is one receiver", () => {
    const declared = new Receiver(chat);
    const routing = AlertRouting({ receiver: declared, levels: [{ name: "a", severities: ["a"], receiver: pager }, { name: "b", severities: ["b"], receiver: pager }] });
    const receivers = Object.values(routing.members).filter(isReceiver);
    expect(receivers.map((r) => r.props.name)).toEqual(["pager"]);
    expect(buildAlertmanagerConfig([declared, ...values(routing)]).config.receivers?.map((r) => r.name)).toEqual(["chat", "pager"]);
  });

  test("bad props are refused", () => {
    expect(() => AlertRouting({ levels: [{ name: "a", severities: ["x"] }, { name: "b", severities: ["x"] }] })).toThrow(
      /AlertRouting: levels\[1\]: severity "x" is already in level "a"/,
    );
    expect(() => AlertRouting({ levels: [{ name: "a", severities: [] }] })).toThrow(/at least one severity/);
    expect(() => AlertRouting({ levels: [{ name: "a", severities: ["x"] }, { name: "a", severities: ["y"] }] })).toThrow(/second level/);
    expect(() => AlertRouting({ receiver: { name: "x" }, levels: [{ name: "a", severities: ["a"], receiver: { name: "x" } }] })).toThrow(
      /two receivers are named "x"/,
    );
    expect(() => AlertRouting({ teams: [{ team: "db", receiver: chat, levels: { sev9: pager } }] })).toThrow(/"sev9", which is not a level/);
    expect(() => AlertRouting({ teams: [{ team: "db", receiver: chat }, { team: "db", receiver: chat }] })).toThrow(/listed twice/);
    expect(() => AlertRouting({ teamLabel: "team-name" })).toThrow(/teamLabel/);
    expect(() => AlertRouting({ groupWait: "soon" })).toThrow(/groupWait/);
  });
});
