/**
 * `RedAlerts` over a spanmetrics connector's names: the expressions are the
 * ones `RedDashboard` runs (both from the otel lexicon's
 * `spanMetricsRedQueries()`), the rules pass the lexicon's checks, and over
 * fixed series the alerts fire for the service that is failing or slow and
 * for no other. `promtool check rules` runs when promtool is on PATH.
 */
import { describe, expect, test } from "vitest";
import { spanMetricsNames, spanMetricsRedQueries, type SpanMetricsNames } from "@intentius/chant-lexicon-otel/metric-names";
import { RedMetrics } from "@intentius/chant-lexicon-otel/composites/red-metrics";
import { RedAlerts, redAlertRules, RED_ALERT_NAMES, type RedAlertsProps } from "./red-alerts";
import { ruleGroupConfig } from "../rules";
import { emitYaml } from "../build";
import { RuleEvaluator, type Labels, type FiringAlert } from "../rule-eval";
import { validateRuleFile } from "../validate-config";
import { hasTool, promtoolCheckRules } from "../tools";
import { isAlertingRuleConfig, type AlertingRuleConfig, type RuleGroupConfig } from "../model";

const MIN = 60_000;
const hasPromtool = hasTool(process.env.PROMTOOL ?? "promtool");
const names = spanMetricsNames({ namespace: "shop", histogram: { unit: "s" } });

function groupOf(props: Partial<RedAlertsProps> = {}): RuleGroupConfig {
  return ruleGroupConfig(RedAlerts({ spanMetrics: names, ...props }).rules);
}

function alerts(group: RuleGroupConfig): AlertingRuleConfig[] {
  return group.rules.filter(isAlertingRuleConfig);
}

/**
 * Per-minute increments. Service `a` serves 100 spans a minute, 10 of them in
 * error, half under 0.5s, 60 under 1s and the rest under 2.5s. Service `b`
 * serves 100, none in error, all under 0.5s, and makes 50 failing client
 * calls a minute, which the alerts don't count.
 */
function feed(n: SpanMetricsNames): (ev: RuleEvaluator, minute: number) => void {
  const series: Array<{ labels: Labels; perMin: number }> = [];
  const span = (service: string, kind: string, status: string) => ({
    service_name: service,
    span_name: "GET /",
    span_kind: kind,
    status_code: status,
  });
  const calls = n.calls.prometheus;
  const buckets = `${n.duration!.prometheus}_bucket`;
  series.push({ labels: { __name__: calls, ...span("a", "SPAN_KIND_SERVER", "STATUS_CODE_UNSET") }, perMin: 90 });
  series.push({ labels: { __name__: calls, ...span("a", "SPAN_KIND_SERVER", "STATUS_CODE_ERROR") }, perMin: 10 });
  series.push({ labels: { __name__: calls, ...span("b", "SPAN_KIND_SERVER", "STATUS_CODE_UNSET") }, perMin: 100 });
  series.push({ labels: { __name__: calls, ...span("b", "SPAN_KIND_CLIENT", "STATUS_CODE_ERROR") }, perMin: 50 });
  const bucket = (service: string, le: string, perMin: number) =>
    series.push({ labels: { __name__: buckets, ...span(service, "SPAN_KIND_SERVER", "STATUS_CODE_UNSET"), le }, perMin });
  for (const [le, a, b] of [
    ["0.5", 50, 100],
    ["1", 60, 100],
    ["2.5", 100, 100],
    ["+Inf", 100, 100],
  ] as const) {
    bucket("a", le, a);
    bucket("b", le, b);
  }
  return (ev, minute) => {
    for (const s of series) ev.add(s.labels, minute * MIN, s.perMin * minute);
  };
}

function run(group: RuleGroupConfig, minutes = 15): Map<number, FiringAlert[]> {
  const ev = new RuleEvaluator([group]);
  const push = feed(names);
  const firing = new Map<number, FiringAlert[]>();
  for (let minute = 0; minute <= minutes; minute++) {
    push(ev, minute);
    firing.set(minute, ev.step(minute * MIN));
  }
  return firing;
}

const fired = (list: FiringAlert[] | undefined) => (list ?? []).map((a) => `${a.labels.alertname}{${a.labels.service_name}}`).sort();

describe("RedAlerts defaults", () => {
  const group = groupOf();

  test("one group, red, with the error-ratio and latency alerts, warning, for 10m", () => {
    expect(group.name).toBe("red");
    expect(alerts(group).map((r) => [r.alert, r.for, r.labels?.severity])).toEqual([
      [RED_ALERT_NAMES.errorRatio, "10m", "warning"],
      [RED_ALERT_NAMES.latency, "10m", "warning"],
    ]);
  });

  test("the expressions are spanMetricsRedQueries' over 5m, the same builder RedDashboard reads", () => {
    const q = spanMetricsRedQueries(names, { range: "5m", quantiles: [0.95] });
    const [err, lat] = alerts(group);
    expect(err.expr).toBe(`${q.errorRatio} > 0.05`);
    expect(lat.expr).toBe(`${q.duration[0].expr} > 1`);
    expect(err.expr).toContain('span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"');
  });

  test("the rule file passes the lexicon's checks", () => {
    expect(validateRuleFile({ groups: [group] })).toEqual([]);
  });

  test("fires for the failing, slow service only, once `for` has held", () => {
    const firing = run(group);
    expect(fired(firing.get(5))).toEqual([]);
    expect(fired(firing.get(15))).toEqual([`${RED_ALERT_NAMES.errorRatio}{a}`, `${RED_ALERT_NAMES.latency}{a}`]);
    const err = firing.get(15)!.find((a) => a.labels.alertname === RED_ALERT_NAMES.errorRatio)!;
    expect(err.value).toBeCloseTo(0.1, 6);
  });

  test.skipIf(!hasPromtool)("promtool check rules passes", () => {
    const result = promtoolCheckRules(emitYaml({ groups: [group] }));
    expect(result.ran).toBe(true);
    expect(result.ok, result.output).toBe(true);
  });
});

describe("RedAlerts options", () => {
  test("thresholds, quantile, severity, window and labels", () => {
    const group = groupOf({
      errorRatio: { threshold: 0.2, severity: "critical", annotations: { runbook_url: "https://runbooks.example.com/red" } },
      latency: { quantile: 0.99, thresholdSeconds: 3, for: "5m" },
      rateWindow: "10m",
      name: "shop-red",
      labels: { team: "shop" },
    });
    expect(group.name).toBe("shop-red");
    expect(group.labels).toEqual({ team: "shop" });
    const [err, lat] = alerts(group);
    expect(err.expr.endsWith("> 0.2")).toBe(true);
    expect(err.expr).toContain("[10m]");
    expect(err.labels?.severity).toBe("critical");
    expect(err.annotations?.runbook_url).toBe("https://runbooks.example.com/red");
    expect(lat.expr.startsWith("histogram_quantile(0.99,")).toBe(true);
    expect(lat.expr.endsWith("> 3")).toBe(true);
    expect(lat.for).toBe("5m");
    // 0.2 is above a's 0.1, and a's p99 (about 2.46s) is under 3s.
    expect(fired(run(group).get(15))).toEqual([]);
  });

  test("a millisecond histogram gets the threshold in milliseconds", () => {
    const ms = spanMetricsNames({});
    const [, lat] = redAlertRules({ spanMetrics: ms, latency: { thresholdSeconds: 0.25 } });
    expect(lat.expr).toContain("traces_span_metrics_duration_milliseconds_bucket");
    expect(lat.expr.endsWith("> 250")).toBe(true);
  });

  test("minRate keeps quiet services quiet", () => {
    const group = groupOf({ minRate: 10 });
    expect(alerts(group)[0].expr).toContain("\nand on (service_name)\n");
    expect(validateRuleFile({ groups: [group] })).toEqual([]);
    // a sees 100 spans a minute, under 10 a second.
    expect(fired(run(group).get(15))).toEqual([]);
  });

  test("either alert can be left out; without a histogram the latency alert is left out unless asked for", () => {
    expect(alerts(groupOf({ latency: false })).map((r) => r.alert)).toEqual([RED_ALERT_NAMES.errorRatio]);
    expect(alerts(groupOf({ errorRatio: false })).map((r) => r.alert)).toEqual([RED_ALERT_NAMES.latency]);
    const noHistogram = spanMetricsNames({ histogram: { disable: true } });
    expect(redAlertRules({ spanMetrics: noHistogram }).map((r) => r.alert)).toEqual([RED_ALERT_NAMES.errorRatio]);
    expect(() => redAlertRules({ spanMetrics: noHistogram, latency: true })).toThrow(/RedAlerts: latency needs the connector's duration histogram/);
    expect(() => RedAlerts({ spanMetrics: names, errorRatio: false, latency: false })).toThrow(/nothing to alert on/);
  });

  test("reads the names from RedMetrics' connector and exporter", () => {
    const red = RedMetrics({ spanMetrics: { namespace: "edge" } });
    const [err] = redAlertRules({ spanMetrics: red.spanMetrics, exporter: red.exporter });
    expect(err.expr).toContain("edge_calls_total");
  });

  test("bad props are refused", () => {
    expect(() => redAlertRules({} as RedAlertsProps)).toThrow(/spanMetrics is required/);
    expect(() => groupOf({ errorRatio: { threshold: 1 } })).toThrow(/errorRatio.threshold/);
    expect(() => groupOf({ latency: { quantile: 1 } })).toThrow(/latency.quantile/);
    expect(() => groupOf({ latency: { thresholdSeconds: 0 } })).toThrow(/latency.thresholdSeconds/);
    expect(() => groupOf({ rateWindow: "five" })).toThrow(/rateWindow/);
    expect(() => groupOf({ groupBy: ["a-b"] })).toThrow(/groupBy/);
    expect(() => groupOf({ minRate: 0 })).toThrow(/minRate/);
    expect(() => groupOf({ name: "a b" })).toThrow(/name "a b"/);
    expect(() => groupOf({ errorRatio: { for: "soon" } })).toThrow(/errorRatio.for/);
  });
});
