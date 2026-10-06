/**
 * The promtool tests generated from an `Slo`: their shape always, and
 * `promtool test rules` over them when promtool is on PATH (or named by
 * $PROMTOOL).
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { Slo, sloMetrics } from "../composites/slo";
import { ruleFileYaml } from "../build";
import { hasTool, promtoolTestRules } from "../tools";
import { seriesLabels, seriesValues, sloRuleTests } from "./slo-rule-tests";

const PROMTOOL = process.env.PROMTOOL ?? "promtool";

const slo = Slo({
  name: "checkout",
  objective: 0.995,
  window: "30d",
  sli: {
    good: 'sum(rate(requests_total{code!~"5.."}[{{window}}]))',
    total: "sum(rate(requests_total[{{window}}]))",
  },
});
const input = { slo, good: 'requests_total{code="200"}', bad: 'requests_total{code="500"}' };

interface TestFile {
  rule_files: string[];
  evaluation_interval: string;
  tests: Array<{
    interval: string;
    input_series: Array<{ series: string; values: string }>;
    alert_rule_test: Array<{ eval_time: string; alertname: string; exp_alerts: Array<{ exp_labels: Record<string, string> }> }>;
  }>;
}

describe("sloRuleTests", () => {
  test("series parsing and promtool's a+bxn notation", () => {
    expect(seriesLabels('requests_total{code="200", job="api"}')).toEqual({ __name__: "requests_total", code: "200", job: "api" });
    expect(seriesLabels("up")).toEqual({ __name__: "up" });
    expect(() => seriesLabels('x{code=~"5.."}')).toThrow(/equality only/);
    expect(seriesValues([0, 10, 20, 30, 35, 40])).toBe("0+10x3 35+5x1");
    expect(seriesValues([5])).toBe("5");
  });

  test("one file per step size, each naming rules.yml, two scenarios per burn-rate pair", () => {
    const files = sloRuleTests([input]).map((y) => load(y) as TestFile);
    const m = sloMetrics(slo);
    expect(files.map((f) => f.evaluation_interval)).toEqual(["1m", "5m"]);
    for (const f of files) expect(f.rule_files).toEqual(["rules.yml"]);
    expect(files.reduce((n, f) => n + f.tests.length, 0)).toBe(2 * m.burnRates.length);
    expect(files[0].tests[0].input_series.map((s) => s.series)).toEqual([input.good, input.bad]);
  });

  test("the expectations come from the evaluator: each pair fires above its rate and not below it", () => {
    const files = sloRuleTests([input]).map((y) => load(y) as TestFile);
    const m = sloMetrics(slo);
    const tests = files.flatMap((f) => f.tests);
    m.burnRates.forEach((b, i) => {
      const [above, below] = [tests[2 * i], tests[2 * i + 1]];
      const fires = (t: (typeof tests)[number], k: number) =>
        t.alert_rule_test[k].exp_alerts.some((a) => Object.entries(b.labels).every(([key, v]) => a.exp_labels[key] === v));
      expect(fires(above, 0), `${b.long}/${b.short} before onset`).toBe(false);
      expect(fires(above, 1), `${b.long}/${b.short} after onset`).toBe(true);
      expect(fires(above, 2), `${b.long}/${b.short} end of burn`).toBe(true);
      expect(fires(below, 0), `${b.long}/${b.short} at 0.9x`).toBe(false);
      expect(above.alert_rule_test[0].alertname).toBe(m.alertName);
    });
  });

  test.skipIf(!hasTool(PROMTOOL))(
    "promtool test rules agrees with every generated file",
    () => {
      const rules = ruleFileYaml([slo.rules]);
      for (const yaml of sloRuleTests([input])) {
        const r = promtoolTestRules(rules, yaml, PROMTOOL);
        expect(r.ok, r.output).toBe(true);
      }
    },
    300_000,
  );
});
