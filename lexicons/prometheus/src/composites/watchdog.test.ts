/**
 * `Watchdog`: the always-firing alert, its heartbeat route and receiver, and
 * that the rule file and `alertmanager.yml` built with it pass the lexicon's
 * checks once the route is nested under a root.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { Watchdog, WATCHDOG_URL_FILE } from "./watchdog";
import { AlertRouting } from "./alert-routing";
import { Receiver } from "../alertmanager";
import { buildAlertmanagerConfig, buildRuleFile } from "../build";
import { validateAlertmanagerConfig, validateRuleFile, validateSeverityRouting } from "../validate-config";
import { RuleEvaluator } from "../rule-eval";
import { ruleGroupConfig } from "../rules";

const values = (...instances: Array<{ members: Record<string, unknown> }>) =>
  instances.flatMap((i) => Object.values(i.members)) as Declarable[];

describe("Watchdog defaults", () => {
  const watchdog = Watchdog({});

  test("one alert, Watchdog, on vector(1) with severity none, in group watchdog", () => {
    const group = ruleGroupConfig(watchdog.rules);
    expect(group.name).toBe("watchdog");
    expect(group.rules).toHaveLength(1);
    expect(group.rules[0]).toMatchObject({ alert: "Watchdog", expr: "vector(1)", labels: { severity: "none" } });
    expect(validateRuleFile(buildRuleFile([watchdog.rules]).config)).toEqual([]);
  });

  test("it fires from the first evaluation", () => {
    const ev = new RuleEvaluator([ruleGroupConfig(watchdog.rules)]);
    expect(ev.step(0).map((a) => a.labels.alertname)).toEqual(["Watchdog"]);
  });

  test("the route matches the alert and sends it to a heartbeat webhook reading its URL from a file", () => {
    expect(watchdog.route.props).toMatchObject({
      matchers: ['alertname="Watchdog"', 'severity="none"'],
      group_wait: "0s",
      group_interval: "1m",
      repeat_interval: "1m",
    });
    expect(watchdog.receiver?.props).toEqual({ name: "heartbeat", webhook_configs: [{ url_file: WATCHDOG_URL_FILE, send_resolved: false }] });
  });

  test("nested under AlertRouting, alertmanager.yml passes the checks and the watchdog route comes first", () => {
    const routing = AlertRouting({ routes: [watchdog.route] });
    const built = buildAlertmanagerConfig(values(watchdog, routing));
    expect(built.warnings).toEqual([]);
    expect(built.config.route?.routes?.[0]).toMatchObject({ receiver: "heartbeat", matchers: ['alertname="Watchdog"', 'severity="none"'] });
    expect(validateAlertmanagerConfig(built.config)).toEqual([]);
    expect(validateSeverityRouting([buildRuleFile([watchdog.rules]).config], built.config)).toEqual([]);
  });

  test("left unnested, it is a second root and the build says so", () => {
    const routing = AlertRouting({});
    expect(buildAlertmanagerConfig(values(watchdog, routing)).warnings.join("\n")).toMatch(/2 root Routes/);
  });
});

describe("Watchdog options", () => {
  test("a receiver of your own, by entity, props or name; and the alert's name, severity and repeat", () => {
    const pd = new Receiver({ name: "pd-heartbeat", webhook_configs: [{ url_file: "/secrets/pd" }] });
    const byEntity = Watchdog({ receiver: pd, alert: "DeadMansSwitch", severity: "heartbeat", repeatInterval: "5m" });
    expect(byEntity.receiver).toBeUndefined();
    expect(byEntity.route.props).toMatchObject({ receiver: pd, matchers: ['alertname="DeadMansSwitch"', 'severity="heartbeat"'], repeat_interval: "5m" });
    expect(Watchdog({ receiver: "elsewhere" }).route.props.receiver).toBe("elsewhere");
    expect(Watchdog({ receiver: { name: "hc", webhook_configs: [{ url_file: "/secrets/hc" }] } }).receiver?.props.name).toBe("hc");
    expect(Watchdog({ urlFile: "/secrets/x" }).receiver?.props.webhook_configs?.[0].url_file).toBe("/secrets/x");
  });

  test("a repeat under a minute brings the group interval down with it (PROM223)", () => {
    const fast = Watchdog({ repeatInterval: "30s" });
    expect(fast.route.props).toMatchObject({ group_interval: "30s", repeat_interval: "30s" });
    const built = buildAlertmanagerConfig(values(fast, AlertRouting({ routes: [fast.route] })));
    expect(validateAlertmanagerConfig(built.config)).toEqual([]);
  });

  test("bad props are refused", () => {
    expect(() => Watchdog({ alert: "dead man" })).toThrow(/Watchdog: alert "dead man"/);
    expect(() => Watchdog({ repeatInterval: "often" })).toThrow(/repeatInterval/);
    expect(() => Watchdog({ urlFile: "/x", receiver: "y" })).toThrow(/urlFile configures the default receiver/);
    expect(() => Watchdog({ severity: "" })).toThrow(/severity/);
    expect(() => Watchdog({ group: "a b" })).toThrow(/group "a b"/);
  });
});
