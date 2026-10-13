/**
 * `promtool test rules` input generated from `Slo` declarations (#3369),
 * lifted from `composites/slo-burn.test.ts`.
 *
 * For each burn-rate pair an `Slo` builds, two synthetic scenarios over a
 * good and a bad request counter: healthy for the pair's long window, then
 * burning the error budget at 1.25 times the pair's factor (it must fire)
 * and at 0.9 times it (it must not). The small evaluator in `rule-eval.ts`
 * runs the SLO's rules over each scenario and says which alerts fire at a
 * few evaluation times around the expected onset; those become the
 * `alert_rule_test` expectations, so `promtool test rules` holds Prometheus
 * to the same answer.
 *
 * The SLI expressions are the author's, so the generator cannot invent the
 * series they read: `good` and `bad` name one series each (`metric{labels}`),
 * counters such that the SLI counts `good` as good events and `bad` as bad
 * ones. The evaluator throws on PromQL it does not implement, which then
 * fails here, at authoring time, rather than in promtool.
 *
 * Pairs whose long window is a day or more step in five minutes, the rest in
 * one, and promtool's `evaluation_interval` is per file, so the result is
 * one test file per step size.
 */

import { dump } from "js-yaml";
import { sloMetrics, type SloBurnRate, type SloInstance } from "../composites/slo";
import { ruleGroupConfig } from "../rules";
import { RuleEvaluator, type FiringAlert } from "../rule-eval";
import { durationMs } from "../duration";
import type { AlertingRuleConfig } from "../model";

const MIN = 60_000;

export interface SloTestInput {
  /** The `Slo(...)` result. */
  slo: SloInstance;
  /** The good-events counter, e.g. `requests_total{code="200"}`. */
  good: string;
  /** The bad-events counter, e.g. `requests_total{code="500"}`. */
  bad: string;
  /** Events per minute. Default 1000. */
  rate?: number;
}

interface Scenario {
  step: number;
  healthy: number;
  burning: number;
  burn: number;
}

/** `metric{a="1",b="2"}` as a label set with `__name__`. */
export function seriesLabels(series: string): Record<string, string> {
  const m = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)\s*(?:\{(.*)\})?\s*$/.exec(series);
  if (!m) throw new Error(`"${series}" is not a series: write metric{label="value",...}`);
  const labels: Record<string, string> = { __name__: m[1] };
  const body = m[2]?.trim();
  if (body) {
    const re = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:,|$)/y;
    let pos = 0;
    while (pos < body.length) {
      re.lastIndex = pos;
      const p = re.exec(body);
      if (!p) throw new Error(`"${series}": label matchers must be name="value" (equality only)`);
      labels[p[1]] = p[2].replace(/\\(.)/g, "$1");
      pos = re.lastIndex;
    }
  }
  return labels;
}

/** Counter samples as promtool's `a+bxn` segments. */
export function seriesValues(values: number[]): string {
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

function isPair(a: FiringAlert, b: SloBurnRate): boolean {
  return a.labels.alertname === b.alert && Object.entries(b.labels).every(([k, v]) => a.labels[k] === v);
}

const minutes = (d: string): number => durationMs(d)! / MIN;

/** One scenario: the counters' samples, and the evaluator's firing alerts by minute. */
function simulate(input: SloTestInput, s: Scenario) {
  const m = sloMetrics(input.slo);
  const rate = input.rate ?? 1000;
  const goodLabels = seriesLabels(input.good);
  const badLabels = seriesLabels(input.bad);
  const ev = new RuleEvaluator([ruleGroupConfig(input.slo.rules)]);
  const total = s.healthy + s.burning;
  const good: number[] = [];
  const bad: number[] = [];
  let g = 0;
  let e = 0;
  const timeline = new Map<number, FiringAlert[]>();
  for (let minute = 0; minute <= total; minute += s.step) {
    if (minute > 0) {
      const burning = minute > s.healthy && minute <= s.healthy + s.burning;
      const b = burning ? rate * s.step * s.burn * m.errorBudget : 0;
      e += b;
      g += rate * s.step - b;
    }
    good.push(g);
    bad.push(e);
    ev.add(goodLabels, minute * MIN, g);
    ev.add(badLabels, minute * MIN, e);
    timeline.set(minute, ev.step(minute * MIN));
  }
  return { good, bad, timeline };
}

function testGroup(input: SloTestInput, s: Scenario, checkAt: number[]) {
  const m = sloMetrics(input.slo);
  const alertRules = ruleGroupConfig(input.slo.rules).rules.filter((r): r is AlertingRuleConfig => "alert" in r);
  const { good, bad, timeline } = simulate(input, s);
  return {
    interval: `${s.step}m`,
    input_series: [
      { series: input.good, values: seriesValues(good) },
      { series: input.bad, values: seriesValues(bad) },
    ],
    alert_rule_test: checkAt.map((minute) => ({
      eval_time: `${minute}m`,
      alertname: m.alertName,
      exp_alerts: (timeline.get(minute) ?? [])
        .filter((a) => a.labels.alertname === m.alertName)
        .map((a) => {
          const rule = alertRules.find((r) => Object.entries(r.labels ?? {}).every(([k, v]) => a.labels[k] === v));
          const { alertname: _, ...labels } = a.labels;
          return { exp_labels: labels, ...(rule?.annotations ? { exp_annotations: rule.annotations } : {}) };
        }),
    })),
  };
}

/**
 * The `promtool test rules` files for these SLOs, one per step size, each
 * naming `rules.yml` (where `promtoolTestRules` writes the rule file).
 */
export function sloRuleTests(inputs: SloTestInput[]): string[] {
  const byStep = new Map<number, unknown[]>();
  for (const input of inputs) {
    for (const b of sloMetrics(input.slo).burnRates) {
      const long = minutes(b.long);
      const step = long >= 24 * 60 ? 5 : 1;
      const snap = (x: number) => Math.round(x / step) * step;
      const above: Scenario = { step, healthy: long, burning: long, burn: b.factor * 1.25 };
      const fireAt = above.healthy + ((long - step) * b.factor) / above.burn;
      const below: Scenario = { step, healthy: long, burning: long, burn: b.factor * 0.9 };
      const groups = byStep.get(step) ?? [];
      groups.push(testGroup(input, above, [snap(fireAt - 4 * step), snap(fireAt + 4 * step), above.healthy + long]));
      groups.push(testGroup(input, below, [below.healthy + long]));
      byStep.set(step, groups);
    }
  }
  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, tests]) => dump({ rule_files: ["rules.yml"], evaluation_interval: `${step}m`, tests }, { lineWidth: -1 }));
}
