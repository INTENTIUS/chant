/**
 * Burn-rate alerts over synthetic series: each window pair fires at its
 * burn rate and not below it.
 *
 * A scenario is a request counter split into good (`code="200"`) and bad
 * (`code="500"`) series, healthy for as long as the pair's long window and
 * then failing at a constant multiple of the error budget. The rule file an
 * `Slo` builds is evaluated over it step by step:
 *
 * - by the small evaluator in `rule-eval.ts`, which always runs, and
 * - by `promtool test rules`, when promtool is on PATH (or named by
 *   $PROMTOOL), against expectations the evaluator produced, so the two
 *   engines are held to the same answer.
 */
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { Slo, sloMetrics, type SloBurnRate, type SloProps } from "./slo";
import { ruleGroupConfig } from "../rules";
import { ruleFileYaml } from "../build";
import { RuleEvaluator, type FiringAlert } from "../rule-eval";
import { durationMs } from "../duration";
import { hasTool, promtoolTestRules } from "../tools";
import type { AlertingRuleConfig } from "../model";

const PROMTOOL = process.env.PROMTOOL ?? "promtool";
const hasPromtool = hasTool(PROMTOOL);
const MIN = 60_000;
/** Requests per minute. */
const RATE = 1000;

function props(window: string): SloProps {
  return {
    name: "checkout",
    objective: 0.995,
    window,
    sli: {
      good: 'sum(rate(requests_total{code!~"5.."}[{{window}}]))',
      total: "sum(rate(requests_total[{{window}}]))",
    },
  };
}

interface Scenario {
  /** Sample and evaluation interval, in minutes. */
  step: number;
  /** Healthy minutes before the burn starts. */
  healthy: number;
  /** Minutes of burn. */
  burning: number;
  /** Minutes of health after the burn. */
  recovered?: number;
  /** The burn rate: a multiple of the error budget. */
  burn: number;
}

/** Bad requests in the minute ending at `minute`. */
function badPerStep(s: Scenario, stepEnd: number, budget: number): number {
  const burning = stepEnd > s.healthy && stepEnd <= s.healthy + s.burning;
  return burning ? RATE * s.step * s.burn * budget : 0;
}

/** Firing alerts for one pair's labels at each evaluation, by minute. */
function run(slo: ReturnType<typeof Slo>, s: Scenario): Map<number, FiringAlert[]> {
  const m = sloMetrics(slo);
  const ev = new RuleEvaluator([ruleGroupConfig(slo.rules)]);
  const total = s.healthy + s.burning + (s.recovered ?? 0);
  let good = 0;
  let bad = 0;
  const out = new Map<number, FiringAlert[]>();
  for (let minute = 0; minute <= total; minute += s.step) {
    if (minute > 0) {
      const b = badPerStep(s, minute, m.errorBudget);
      bad += b;
      good += RATE * s.step - b;
    }
    ev.add({ __name__: "requests_total", code: "200" }, minute * MIN, good);
    ev.add({ __name__: "requests_total", code: "500" }, minute * MIN, bad);
    out.set(minute, ev.step(minute * MIN));
  }
  return out;
}

function isPair(a: FiringAlert, b: SloBurnRate): boolean {
  return a.labels.alertname === b.alert && a.labels.long_window === b.long && a.labels.short_window === b.short;
}

/** The first minute the pair fires, or undefined. */
function firstFiring(timeline: Map<number, FiringAlert[]>, b: SloBurnRate, from = 0): number | undefined {
  for (const [minute, alerts] of timeline) if (minute >= from && alerts.some((a) => isPair(a, b))) return minute;
  return undefined;
}

const minutes = (d: string) => durationMs(d)! / MIN;

describe("each pair fires at its burn rate and not below it (rule-eval)", () => {
  for (const window of ["30d", "28d"]) {
    const slo = Slo(props(window));
    const m = sloMetrics(slo);
    for (const b of m.burnRates) {
      const long = minutes(b.long);
      const short = minutes(b.short);
      // Five-minute steps for the ticket pairs keep days of samples quick.
      const step = long >= 24 * 60 ? 5 : 1;

      test(`${window} ${b.severity} ${b.long}/${b.short}: fires once the long window has burnt ${b.factor}x, then stops within the short window`, () => {
        const s: Scenario = { step, healthy: long, burning: long, recovered: long, burn: b.factor * 1.25 };
        const timeline = run(slo, s);
        const fired = firstFiring(timeline, b);
        // The long window's error ratio climbs linearly from the onset and crosses
        // the threshold after long * factor / burn of it.
        const expected = s.healthy + ((long - step) * b.factor) / s.burn;
        expect(fired, "never fired").toBeDefined();
        expect(Math.abs(fired! - expected)).toBeLessThanOrEqual(2 * step);
        // Nothing before the onset.
        expect(firstFiring(timeline, b)).toBeGreaterThan(s.healthy);
        // Still firing at the end of the burn.
        expect(timeline.get(s.healthy + s.burning)!.some((a) => isPair(a, b))).toBe(true);
        // After the burn stops the long window is still above the threshold, but
        // the short window drops below it, so the alert resets.
        let stopped: number | undefined;
        for (const [minute, alerts] of timeline) {
          if (minute > s.healthy + s.burning && !alerts.some((a) => isPair(a, b))) {
            stopped = minute;
            break;
          }
        }
        expect(stopped, "kept firing").toBeDefined();
        expect(stopped! - (s.healthy + s.burning)).toBeLessThanOrEqual(short + step);
      });

      test(`${window} ${b.severity} ${b.long}/${b.short}: never fires at 0.9x its burn rate`, () => {
        const s: Scenario = { step, healthy: long, burning: 2 * long, burn: b.factor * 0.9 };
        const timeline = run(slo, s);
        expect(firstFiring(timeline, b)).toBeUndefined();
      });
    }
  }

  test("a 28-day SLO pages at 14x, where a 30-day one does not: the factors scale with the window", () => {
    for (const [window, fires] of [["28d", true], ["30d", false]] as const) {
      const slo = Slo(props(window));
      const b = sloMetrics(slo).burnRates[0];
      const timeline = run(slo, { step: 1, healthy: 60, burning: 120, burn: 14 });
      expect(firstFiring(timeline, b) !== undefined, window).toBe(fires);
    }
  });

  test("error budget remaining is 1 minus the burn rate after a whole window of steady burn", () => {
    const slo = Slo({ ...props("1d"), alerting: { page: { burnRates: [{ long: "1h", short: "5m", factor: 14.4 }] }, ticket: false } });
    const m = sloMetrics(slo);
    const ev = new RuleEvaluator([ruleGroupConfig(slo.rules)]);
    let good = 0;
    let bad = 0;
    const burn = 0.5;
    for (let minute = 0; minute <= 26 * 60; minute++) {
      if (minute > 0) {
        bad += RATE * burn * m.errorBudget;
        good += RATE * (1 - burn * m.errorBudget);
      }
      ev.add({ __name__: "requests_total", code: "200" }, minute * MIN, good);
      ev.add({ __name__: "requests_total", code: "500" }, minute * MIN, bad);
      ev.step(minute * MIN);
    }
    const [remaining] = ev.query(`${m.errorBudgetRemaining}${m.selector}`, 26 * 60 * MIN);
    expect(remaining.value).toBeCloseTo(1 - burn, 6);
    const [objective] = ev.query(`${m.objectiveRatio}${m.selector}`, 26 * 60 * MIN);
    expect(objective.value).toBe(0.995);
  });
});

/** `a+bxn` segments for one counter, sample by sample. */
function seriesValues(values: number[]): string {
  // Written out as increments per segment of equal steps.
  const parts: string[] = [];
  let i = 0;
  while (i < values.length) {
    const start = values[i];
    if (i + 1 >= values.length) {
      parts.push(`${start}`);
      break;
    }
    const inc = values[i + 1] - values[i];
    let j = i + 1;
    while (j + 1 < values.length && Math.abs(values[j + 1] - values[j] - inc) < 1e-9) j++;
    parts.push(`${start}+${inc}x${j - i}`);
    i = j + 1;
  }
  return parts.join(" ");
}

describe.skipIf(!hasPromtool)("each pair fires at its burn rate and not below it (promtool test rules)", () => {
  const slo = Slo(props("30d"));
  const m = sloMetrics(slo);
  const alertRules = ruleGroupConfig(slo.rules).rules.filter((r): r is AlertingRuleConfig => "alert" in r);
  const rulesYaml = ruleFileYaml([slo.rules]);

  function testGroup(s: Scenario, checkAt: number[]) {
    const good: number[] = [];
    const bad: number[] = [];
    let g = 0;
    let e = 0;
    const total = s.healthy + s.burning + (s.recovered ?? 0);
    for (let minute = 0; minute <= total; minute += s.step) {
      if (minute > 0) {
        const b = badPerStep(s, minute, m.errorBudget);
        e += b;
        g += RATE * s.step - b;
      }
      good.push(g);
      bad.push(e);
    }
    const timeline = run(slo, s);
    return {
      timeline,
      group: {
        interval: `${s.step}m`,
        input_series: [
          { series: 'requests_total{code="200"}', values: seriesValues(good) },
          { series: 'requests_total{code="500"}', values: seriesValues(bad) },
        ],
        alert_rule_test: checkAt.map((minute) => ({
          eval_time: `${minute}m`,
          alertname: m.alertName,
          exp_alerts: (timeline.get(minute) ?? []).map((a) => {
            const rule = alertRules.find((r) => r.labels!.long_window === a.labels.long_window && r.labels!.short_window === a.labels.short_window)!;
            const { alertname: _, ...labels } = a.labels;
            return { exp_labels: labels, exp_annotations: rule.annotations };
          }),
        })),
      },
    };
  }

  for (const b of m.burnRates) {
    const long = minutes(b.long);
    const step = long >= 24 * 60 ? 5 : 1;
    test(`${b.severity} ${b.long}/${b.short}`, () => {
      const above: Scenario = { step, healthy: long, burning: long, burn: b.factor * 1.25 };
      const fireAt = above.healthy + ((long - step) * b.factor) / above.burn;
      const snap = (x: number) => Math.round(x / step) * step;
      const aboveCheck = [snap(fireAt - 4 * step), snap(fireAt + 4 * step), above.healthy + long];
      const upper = testGroup(above, aboveCheck);
      // The evaluator's own claims, which promtool then confirms.
      expect(upper.timeline.get(aboveCheck[0])!.some((a) => isPair(a, b))).toBe(false);
      expect(upper.timeline.get(aboveCheck[1])!.some((a) => isPair(a, b))).toBe(true);
      expect(upper.timeline.get(aboveCheck[2])!.some((a) => isPair(a, b))).toBe(true);

      const below: Scenario = { step, healthy: long, burning: long, burn: b.factor * 0.9 };
      const lower = testGroup(below, [below.healthy + long]);
      expect(lower.timeline.get(below.healthy + long)!.some((a) => isPair(a, b))).toBe(false);

      const testYaml = dump({ rule_files: ["rules.yml"], evaluation_interval: `${step}m`, tests: [upper.group, lower.group] }, { lineWidth: -1 });
      const r = promtoolTestRules(rulesYaml, testYaml, PROMTOOL);
      expect(r.ran).toBe(true);
      expect(r.ok, r.output).toBe(true);
    }, 120_000);
  }
});

describe("rule-eval", () => {
  test("throws on PromQL it does not implement instead of guessing", () => {
    const ev = new RuleEvaluator([{ name: "g", rules: [{ record: "x", expr: "histogram_quantile(0.9, rate(a[5m]))" }] }]);
    expect(() => ev.step(0)).toThrow(/not supported|needs a range/);
  });

  test("evaluates sums, ratios and set operators the way Prometheus does", () => {
    const ev = new RuleEvaluator([
      {
        name: "g",
        labels: { team: "a" },
        rules: [
          { record: "job:req:rate1m", expr: "sum by (job) (rate(req_total[2m]))" },
          { alert: "High", expr: 'job:req:rate1m > 1 and on (job) job:req:rate1m{job="api"}', labels: { severity: "page" } },
        ],
      },
    ]);
    for (let minute = 0; minute <= 2; minute++) {
      ev.add({ __name__: "req_total", job: "api", i: "1" }, minute * MIN, minute * 60 * 3);
      ev.add({ __name__: "req_total", job: "api", i: "2" }, minute * MIN, minute * 60);
      ev.add({ __name__: "req_total", job: "web", i: "1" }, minute * MIN, minute * 60 * 5);
    }
    const firing = ev.step(2 * MIN);
    expect(ev.query("job:req:rate1m", 2 * MIN).map((e) => [e.labels.job, e.value])).toEqual([
      ["api", 4],
      ["web", 5],
    ]);
    expect(firing).toEqual([{ labels: { job: "api", team: "a", severity: "page", alertname: "High" }, value: 4 }]);
  });
});
