/**
 * The `Slo` composite: validation, the rules it builds, and `sloMetrics()`.
 * The burn-rate behaviour over synthetic series is in slo-burn.test.ts.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { Slo, sloMetrics, sloPropsProblem, type SloProps } from "./slo";
import { ruleGroupConfig } from "../rules";
import { ruleFileYaml } from "../build";
import { validateRuleFile, validateSeverityRouting } from "../validate-config";
import { hasTool, promtoolCheckRules } from "../tools";
import type { AlertingRuleConfig, RecordingRuleConfig, RuleFileConfig } from "../model";

const PROMTOOL = process.env.PROMTOOL ?? "promtool";
const hasPromtool = hasTool(PROMTOOL);

const orderAck: SloProps = {
  name: "order-acknowledged",
  objective: 0.995,
  window: "28d",
  sli: {
    good: 'sum(rate(traces_span_metrics_calls_total{span_name="order.ack",status_code!="STATUS_CODE_ERROR"}[{{window}}]))',
    total: 'sum(rate(traces_span_metrics_calls_total{span_name="order.ack"}[{{window}}]))',
  },
  alerting: { page: { burnRates: "default" }, ticket: { burnRates: "default" } },
};

type SloResult = ReturnType<typeof Slo>;

function file(slo: SloResult): RuleFileConfig {
  return load(ruleFileYaml([slo.rules])) as RuleFileConfig;
}

function recordings(slo: SloResult): RecordingRuleConfig[] {
  return ruleGroupConfig(slo.rules).rules.filter((r): r is RecordingRuleConfig => "record" in r);
}

function alertsOf(slo: SloResult): AlertingRuleConfig[] {
  return ruleGroupConfig(slo.rules).rules.filter((r): r is AlertingRuleConfig => "alert" in r);
}

describe("Slo validation", () => {
  test.each([0, 1, -0.1, 1.5, Number.NaN])("rejects objective %s", (objective) => {
    expect(() => Slo({ ...orderAck, objective })).toThrow(/objective must be strictly between 0 and 1/);
  });

  test.each(["", "28 days", "1.5d", "0", "30m1h"])("rejects window %j", (window) => {
    expect(() => Slo({ ...orderAck, window })).toThrow(/window must be a positive Prometheus duration/);
  });

  test("rejects an SLI without the window placeholder, or one that does not parse", () => {
    expect(() => Slo({ ...orderAck, sli: { good: "sum(rate(x[5m]))", total: "sum(rate(y[{{window}}]))" } })).toThrow(
      /sli.good must contain \{\{window\}\}/,
    );
    expect(() => Slo({ ...orderAck, sli: { errors: "sum(rate(x[{{window}}])", total: "sum(rate(y[{{window}}]))" } })).toThrow(
      /sli.errors is not valid PromQL/,
    );
    expect(() => Slo({ ...orderAck, sli: { total: "sum(rate(y[{{window}}]))" } as never })).toThrow(/good and total, or errors and total/);
  });

  test("rejects a long window longer than the SLO window, and a short window that is not shorter", () => {
    expect(() => Slo({ ...orderAck, window: "2d" })).toThrow(/the long window 3d is longer than the SLO window 2d/);
    expect(() =>
      Slo({ ...orderAck, alerting: { ticket: false, page: { burnRates: [{ long: "1h", short: "1h", factor: 10 }] } } }),
    ).toThrow(/must be shorter/);
    expect(() =>
      Slo({ ...orderAck, alerting: { ticket: false, page: { burnRates: [{ long: "1h", short: "5m", factor: 10, budgetConsumed: 0.02 }] } } }),
    ).toThrow(/exactly one of budgetConsumed and factor/);
  });

  test("rejects a burn rate whose threshold is an error ratio of 1 or more", () => {
    expect(() =>
      Slo({ ...orderAck, objective: 0.9, alerting: { ticket: false, page: { burnRates: [{ long: "1h", short: "5m", factor: 10 }] } } }),
    ).toThrow(/can never happen/);
  });

  test("rejects a name that cannot go in a label and a group name", () => {
    expect(() => Slo({ ...orderAck, name: 'bad"name' })).toThrow(/name must be/);
  });

  test("sloPropsProblem accepts the issue's example", () => {
    expect(sloPropsProblem(orderAck)).toBeUndefined();
  });
});

describe("the rules an Slo builds", () => {
  const slo = Slo(orderAck);

  test("one group, clean under every PROM1xx check, and routable by severity", () => {
    const f = file(slo);
    expect(f.groups.map((g) => g.name)).toEqual(["slo-order-acknowledged"]);
    expect(validateRuleFile(f)).toEqual([]);
    const routes = { route: { receiver: "d", routes: [{ matchers: ['severity="page"'], receiver: "d" }, { matchers: ['severity="ticket"'], receiver: "d" }] }, receivers: [{ name: "d" }] };
    expect(validateSeverityRouting([f], routes)).toEqual([]);
    expect(validateSeverityRouting([f], { route: { receiver: "d", routes: [{ matchers: ['severity="page"'], receiver: "d" }] }, receivers: [{ name: "d" }] })).toHaveLength(1);
  });

  test("an error-ratio series per window, the window's own ratio, the objective and the budget left", () => {
    const rec = recordings(slo);
    expect(rec.map((r) => r.record)).toEqual([
      "slo:sli_error:ratio_rate5m",
      "slo:sli_error:ratio_rate30m",
      "slo:sli_error:ratio_rate1h",
      "slo:sli_error:ratio_rate2h",
      "slo:sli_error:ratio_rate6h",
      "slo:sli_error:ratio_rate1d",
      "slo:sli_error:ratio_rate3d",
      "slo:sli_error:ratio_rate28d",
      "slo:objective:ratio",
      "slo:error_budget:remaining",
    ]);
    for (const r of rec) expect(r.labels).toEqual({ slo: "order-acknowledged" });
    expect(rec[2].expr).toContain('[1h]');
    expect(rec[2].expr).not.toContain("{{window}}");
    expect(rec[7].expr).toBe('avg_over_time(slo:sli_error:ratio_rate5m{slo="order-acknowledged"}[28d])');
    expect(rec[9].expr).toBe('1 - (slo:sli_error:ratio_rate28d{slo="order-acknowledged"} / 0.005)');
  });

  test("one alert per window pair, factors scaled from 30 days to 28", () => {
    const alerts = alertsOf(slo);
    expect(alerts.map((a) => [a.alert, a.labels!.severity, a.labels!.long_window, a.labels!.short_window])).toEqual([
      ["ErrorBudgetBurn", "page", "1h", "5m"],
      ["ErrorBudgetBurn", "page", "6h", "30m"],
      ["ErrorBudgetBurn", "ticket", "1d", "2h"],
      ["ErrorBudgetBurn", "ticket", "3d", "6h"],
    ]);
    expect(alerts[0].expr).toContain('slo:sli_error:ratio_rate1h{slo="order-acknowledged"} > (13.44 * 0.005)');
    expect(alerts[0].expr).toContain('slo:sli_error:ratio_rate5m{slo="order-acknowledged"} > (13.44 * 0.005)');
    expect(alerts[0].annotations!.summary).toContain("13.44x");
    expect(alerts.every((a) => a.for === undefined)).toBe(true);
  });

  test("a 30-day window keeps the Workbook's factors exactly", () => {
    const m = sloMetrics({ ...orderAck, window: "30d" });
    expect(m.burnRates.map((b) => b.factor)).toEqual([14.4, 6, 3, 1]);
    expect(m.burnRates.map((b) => b.exhaustsIn)).toEqual(["2d2h", "5d", "1w3d", "4w2d"]);
  });

  test("tiers take their own severity, labels, annotations and for; alertName and group options apply", () => {
    const custom = Slo({
      ...orderAck,
      name: "checkout",
      labels: { team: "payments" },
      interval: "30s",
      alerting: {
        alertName: "CheckoutBudgetBurn",
        page: { severity: "critical", for: "2m", labels: { pager: "yes" }, annotations: { runbook_url: "https://runbooks/checkout" } },
        ticket: false,
      },
    });
    const g = ruleGroupConfig(custom.rules);
    expect(g.interval).toBe("30s");
    expect(g.labels).toEqual({ team: "payments" });
    expect(alertsOf(custom)).toHaveLength(2);
    const a = alertsOf(custom)[0];
    expect(a.alert).toBe("CheckoutBudgetBurn");
    expect(a.for).toBe("2m");
    expect(a.labels).toMatchObject({ severity: "critical", pager: "yes", slo: "checkout" });
    expect(a.annotations!.runbook_url).toBe("https://runbooks/checkout");
    expect(sloMetrics(custom).windows).toEqual(["5m", "30m", "1h", "6h", "28d"]);
  });

  test("custom pairs: a factor is used as written, a budget share is scaled", () => {
    const m = sloMetrics({
      ...orderAck,
      window: "7d",
      alerting: { page: { burnRates: [{ long: "2h", short: "10m", factor: 10 }] }, ticket: { burnRates: [{ long: "1d", short: "2h", budgetConsumed: 0.2 }] } },
    });
    expect(m.burnRates.map((b) => b.factor)).toEqual([10, 1.4]);
  });

  test("errors/total SLIs record the ratio directly; no alerting records the window from the SLI", () => {
    const direct = Slo({
      ...orderAck,
      name: "direct",
      sli: { errors: "sum(rate(e_total[{{window}}]))", total: "sum(rate(t_total[{{window}}]))" },
      alerting: { page: false, ticket: false },
    });
    expect(alertsOf(direct)).toEqual([]);
    const rec = recordings(direct);
    expect(rec.map((r) => r.record)).toEqual(["slo:sli_error:ratio_rate28d", "slo:objective:ratio", "slo:error_budget:remaining"]);
    expect(rec[0].expr).toBe("(sum(rate(e_total[28d])))\n/\n(sum(rate(t_total[28d])))");
    expect(sloMetrics(direct).group).toBe("slo-direct");
    expect(sloMetrics(direct).burnRates).toEqual([]);
  });

  test("the same Slo renders inside the rule file promtool accepts", () => {
    const r = promtoolCheckRules(ruleFileYaml([slo.rules]), PROMTOOL);
    if (!hasPromtool) {
      expect(r.ran).toBe(false);
      return;
    }
    expect(r.output).toContain("SUCCESS");
    expect(r.ok).toBe(true);
  });
});

describe("sloMetrics", () => {
  const slo = Slo(orderAck);

  test("names every recorded series, the thresholds and the groups, for dashboards", () => {
    const m = sloMetrics(slo);
    expect(m).toMatchObject({
      name: "order-acknowledged",
      objective: 0.995,
      errorBudget: 0.005,
      window: "28d",
      labels: { slo: "order-acknowledged" },
      selector: '{slo="order-acknowledged"}',
      windows: ["5m", "30m", "1h", "2h", "6h", "1d", "3d", "28d"],
      windowErrorRatio: "slo:sli_error:ratio_rate28d",
      errorBudgetRemaining: "slo:error_budget:remaining",
      objectiveRatio: "slo:objective:ratio",
      alertName: "ErrorBudgetBurn",
      group: "slo-order-acknowledged",
    });
    expect(m.errorRatio["1h"]).toBe("slo:sli_error:ratio_rate1h");
    expect(m.burnRates[0]).toEqual({
      tier: "page",
      severity: "page",
      long: "1h",
      short: "5m",
      factor: 13.44,
      threshold: 0.0672,
      longRecord: "slo:sli_error:ratio_rate1h",
      shortRecord: "slo:sli_error:ratio_rate5m",
      alert: "ErrorBudgetBurn",
      labels: { slo: "order-acknowledged", severity: "page", long_window: "1h", short_window: "5m" },
      exhaustsIn: "2d2h",
    });
  });

  test("every name it returns is recorded by the rules, so a dashboard never reads a missing series", () => {
    const m = sloMetrics(slo);
    const recorded = new Set(recordings(slo).map((r) => r.record));
    for (const name of [...Object.values(m.errorRatio), m.windowErrorRatio, m.errorBudgetRemaining, m.objectiveRatio]) {
      expect(recorded.has(name), name).toBe(true);
    }
    const alerts = alertsOf(slo);
    m.burnRates.forEach((b, i) => {
      expect(alerts[i].labels).toEqual(b.labels);
      expect(alerts[i].expr).toContain(`${b.longRecord}${m.selector} >`);
    });
  });

  test("reads the same from the instance, its group, or the props", () => {
    expect(sloMetrics(slo.rules)).toEqual(sloMetrics(slo));
    expect(sloMetrics(orderAck)).toEqual(sloMetrics(slo));
  });

  test("returns a copy, so a caller cannot change what the next caller reads", () => {
    const m = sloMetrics(slo);
    m.errorRatio["1h"] = "changed";
    expect(sloMetrics(slo).errorRatio["1h"]).toBe("slo:sli_error:ratio_rate1h");
  });
});
