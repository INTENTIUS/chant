/**
 * `Slo`: a service level objective that builds to Prometheus rules.
 *
 * One declaration expands to one `RuleGroup`, `slo-<name>`, holding:
 *
 * - recording rules: the SLI's error ratio over every window the alerts read
 *   (`slo:sli_error:ratio_rate<window>`), the error ratio over the whole SLO
 *   window, the objective (`slo:objective:ratio`) and the share of the error
 *   budget left (`slo:error_budget:remaining`). Every series carries an
 *   `slo` label with the SLO's name.
 * - multiwindow, multi-burn-rate alerts from the Google SRE Workbook
 *   ("Alerting on SLOs", alert 6). Each alert pairs a long window with a
 *   short one and fires while both burn the error budget faster than the
 *   pair's factor: the long window keeps a short spike from paging, the
 *   short window stops the alert soon after the burn does.
 *
 * An SLI that sees no events in a window (a sparse one: a job that runs a few
 * times a day) records no ratio for that window, where good/total would be
 * 0/0 and record NaN. The SLO window's ratio is an average of the shortest
 * recorded ratio, and one NaN in a range keeps `avg_over_time` NaN for the
 * whole window, so the idle windows are left out and the average covers only
 * the windows that had events. The SLI expressions are the caller's: `rate()`
 * over a counter that first appears inside the range sees one sample and
 * counts nothing, so a sparse SLI should count events as an increase that
 * includes a series' first sample (see the SLOs page).
 *
 * Both kinds share a group because Prometheus evaluates a group's rules in
 * order: the alerts read the ratios recorded in the same evaluation. In
 * separate groups they would read the previous evaluation's, and with an
 * evaluation interval of 5m (the lookback) not at all.
 *
 * The Workbook's factors (14.4, 6, 3 and 1) assume a 30-day SLO window: each
 * is the share of the budget a pair may burn over its long window, times the
 * SLO window, over the long window (2% of the budget in 1h is
 * 0.02 * 720h / 1h = 14.4). For any other window the lexicon keeps the
 * windows and budget shares and recomputes the factor the same way, so a
 * 28-day SLO pages at 0.02 * 672h / 1h = 13.44.
 *
 * `sloMetrics()` returns the recorded series names, the objective, the
 * window and the burn-rate thresholds, so a dashboard or another rule reads
 * them from the declaration instead of repeating them.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { RuleGroup, type AlertingRule, type RecordingRule, type Rule, type RuleGroupEntity } from "../rules";
import type { LabelSet } from "../model";
import { durationMs, formatDuration, isValidDuration } from "../duration";
import { checkPromql } from "../promql";

/** The placeholder an SLI expression writes where its range goes, e.g. `[{{window}}]`. */
export const SLO_WINDOW_PLACEHOLDER = "{{window}}";

/**
 * The SLI as two PromQL expressions over the same events, each with
 * `{{window}}` where the range goes. Either good and total events, or
 * errors (bad events) and total events.
 */
export type SloSli =
  | {
      /** Rate of good events, e.g. `sum(rate(http_requests_total{code!~"5.."}[{{window}}]))`. */
      good: string;
      /** Rate of all events, e.g. `sum(rate(http_requests_total[{{window}}]))`. */
      total: string;
    }
  | {
      /** Rate of bad events, e.g. `sum(rate(http_requests_total{code=~"5.."}[{{window}}]))`. */
      errors: string;
      /** Rate of all events. */
      total: string;
    };

/** One long/short window pair and the burn rate it alerts at. */
export interface BurnRateWindow {
  /** The long window, e.g. `1h`. At most the SLO window. */
  long: string;
  /** The short window, e.g. `5m`. Shorter than `long`; the Workbook uses a twelfth of it. */
  short: string;
  /**
   * Share of the whole error budget this pair may burn over its long window
   * before it alerts, e.g. `0.02`. The factor is derived from it and the SLO
   * window. Set this or `factor`.
   */
  budgetConsumed?: number;
  /** The burn rate itself, used as written for any SLO window. Set this or `budgetConsumed`. */
  factor?: number;
}

/** One alert tier: paging or tickets. */
export interface SloAlertTier {
  /** Window pairs, or `"default"` for the Workbook's pairs for this tier. */
  burnRates?: "default" | BurnRateWindow[];
  /** The `severity` label, which Alertmanager routes on (default: the tier's name, `page` or `ticket`). */
  severity?: string;
  /** How long a pair must hold before its alert fires (default: none; the short window already filters blips). */
  for?: string;
  /** More labels on this tier's alerts. */
  labels?: LabelSet;
  /** More annotations on this tier's alerts, e.g. `runbook_url`. */
  annotations?: LabelSet;
}

export interface SloAlerting {
  /** Fast burns that need someone now (default: on, 1h/5m at 2% and 6h/30m at 5% of the budget). `false` turns it off. */
  page?: SloAlertTier | false;
  /** Slow burns for working hours (default: on, 1d/2h at 10% and 3d/6h at 10% of the budget). `false` turns it off. */
  ticket?: SloAlertTier | false;
  /** The alert name every pair fires under (default: `ErrorBudgetBurn`). Pairs differ by labels. */
  alertName?: string;
}

export interface SloProps {
  /**
   * The SLO's name, the `slo` label on every series and alert it builds and
   * part of its group names. Letters, digits, `.`, `_` and `-`.
   */
  name: string;
  /** The target share of good events, strictly between 0 and 1, e.g. `0.995`. */
  objective: number;
  /** The rolling window the objective holds over, a Prometheus duration, e.g. `28d` or `30d`. */
  window: string;
  /** The SLI: good (or error) events over total events, with `{{window}}` for the range. */
  sli: SloSli;
  /** A sentence for the alerts' description, e.g. what the SLO measures. */
  description?: string;
  /** Burn-rate alerts (default: both tiers with the Workbook's windows). */
  alerting?: SloAlerting;
  /** Labels added to every rule, e.g. `team` or `service`. */
  labels?: LabelSet;
  /** Evaluation interval of the group (default: Prometheus's `evaluation_interval`). */
  interval?: string;
}

export type SloMembers = {
  /** The recording rules, then the burn-rate alerts. */
  rules: RuleGroupEntity;
};

/** What `Slo(...)` returns: its rule group, as `rules`. */
export type SloInstance = CompositeInstance<SloMembers> & SloMembers;

/** One burn-rate pair as built, for dashboards and tests. */
export interface SloBurnRate {
  /** `page` or `ticket`. */
  tier: "page" | "ticket";
  /** The `severity` label the alert carries. */
  severity: string;
  long: string;
  short: string;
  /** The burn rate the pair fires above. */
  factor: number;
  /** The error ratio the pair fires above: `factor * (1 - objective)`. */
  threshold: number;
  /** The recorded error-ratio series each window reads. */
  longRecord: string;
  shortRecord: string;
  /** The alert name. */
  alert: string;
  /** The labels that tell this pair's alert apart, `alertname` excluded. */
  labels: LabelSet;
  /** How long the budget lasts at exactly this burn rate. */
  exhaustsIn: string;
}

/** The series and numbers an `Slo` builds, read by dashboards instead of repeating names. */
export interface SloMetrics {
  /** The SLO's name, the value of the `slo` label. */
  name: string;
  objective: number;
  /** `1 - objective`: the share of events allowed to be bad. */
  errorBudget: number;
  window: string;
  /** The label every recorded series and alert carries. */
  labels: { slo: string };
  /** `{slo="<name>"}`, ready to append to a recorded series name. */
  selector: string;
  /** Every window with an error-ratio series, shortest first; the SLO window is last. */
  windows: string[];
  /** Error-ratio series by window, e.g. `errorRatio["5m"]` is `slo:sli_error:ratio_rate5m`. */
  errorRatio: Record<string, string>;
  /** The error-ratio series over the whole SLO window. */
  windowErrorRatio: string;
  /** `slo:error_budget:remaining`: 1 is untouched, 0 is spent, below 0 is overspent. */
  errorBudgetRemaining: string;
  /** `slo:objective:ratio`: the objective as a series. */
  objectiveRatio: string;
  /** The burn-rate pairs, page tier first. Empty when alerting is off. */
  burnRates: SloBurnRate[];
  /** The alert name every pair fires under. */
  alertName: string;
  /** The rule group's name. */
  group: string;
}

/** The Workbook's pairs ("Alerting on SLOs", table 5-8), as shares of the budget. */
export const DEFAULT_BURN_RATES: Readonly<Record<"page" | "ticket", readonly Readonly<BurnRateWindow>[]>> = Object.freeze({
  page: Object.freeze([
    Object.freeze({ long: "1h", short: "5m", budgetConsumed: 0.02 }),
    Object.freeze({ long: "6h", short: "30m", budgetConsumed: 0.05 }),
  ]),
  ticket: Object.freeze([
    Object.freeze({ long: "1d", short: "2h", budgetConsumed: 0.1 }),
    Object.freeze({ long: "3d", short: "6h", budgetConsumed: 0.1 }),
  ]),
});

const DEFAULT_ALERT_NAME = "ErrorBudgetBurn";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ALERT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLO_METRICS = Symbol.for("chant.prometheus.slo");

/** Record names. */
const errorRatioRecord = (window: string) => `slo:sli_error:ratio_rate${window}`;
const ERROR_BUDGET_REMAINING = "slo:error_budget:remaining";
const OBJECTIVE_RATIO = "slo:objective:ratio";

/** A number as PromQL writes it, without float noise: `1 - 0.995` is `0.005`. */
function num(n: number): string {
  return String(Number(n.toPrecision(10)));
}

function fail(name: string, message: string): never {
  throw new Error(`Slo "${name}": ${message}`);
}

interface ResolvedPair {
  tier: "page" | "ticket";
  tierProps: SloAlertTier;
  long: string;
  short: string;
  factor: number;
}

interface Resolved {
  props: SloProps;
  budget: number;
  windowMs: number;
  pairs: ResolvedPair[];
  alertName: string;
  /** Every window with an error-ratio series, shortest first, SLO window last. */
  windows: string[];
}

/** Check the props and work out every pair's factor; throws on anything the rules could not be built from. */
function resolve(props: SloProps): Resolved {
  const name = typeof props?.name === "string" ? props.name : "";
  if (!NAME.test(name)) fail(name, "name must be letters, digits, '.', '_' or '-', starting with a letter or digit");
  const problem = sloPropsProblem(props);
  if (problem) fail(name, problem);

  const windowMs = durationMs(props.window)!;
  // Rounded, so 1 - 0.995 is 0.005 and not 0.0050000000000000044.
  const budget = Number((1 - props.objective).toPrecision(12));
  const alerting = props.alerting ?? {};
  const alertName = alerting.alertName ?? DEFAULT_ALERT_NAME;
  if (!ALERT_NAME.test(alertName)) fail(name, `alertName "${alertName}" is not a valid alert name`);

  const pairs: ResolvedPair[] = [];
  for (const tier of ["page", "ticket"] as const) {
    const tierProps = alerting[tier];
    if (tierProps === false) continue;
    const t = tierProps ?? {};
    if (t.for !== undefined && !isValidDuration(t.for)) fail(name, `alerting.${tier}.for "${t.for}" is not a Prometheus duration`);
    const windows = t.burnRates === undefined || t.burnRates === "default" ? DEFAULT_BURN_RATES[tier] : t.burnRates;
    if (!Array.isArray(windows) || windows.length === 0) fail(name, `alerting.${tier}.burnRates must be "default" or a non-empty list`);
    windows.forEach((w, i) => {
      const at = `alerting.${tier}.burnRates[${i}]`;
      const longMs = isValidDuration(w.long) ? durationMs(w.long)! : 0;
      const shortMs = isValidDuration(w.short) ? durationMs(w.short)! : 0;
      if (longMs <= 0) fail(name, `${at}.long "${w.long}" is not a positive Prometheus duration`);
      if (shortMs <= 0) fail(name, `${at}.short "${w.short}" is not a positive Prometheus duration`);
      if (shortMs >= longMs) fail(name, `${at}: the short window ${w.short} must be shorter than the long window ${w.long}`);
      if (longMs > windowMs) fail(name, `${at}: the long window ${w.long} is longer than the SLO window ${props.window}`);
      const hasShare = w.budgetConsumed !== undefined;
      const hasFactor = w.factor !== undefined;
      if (hasShare === hasFactor) fail(name, `${at} must set exactly one of budgetConsumed and factor`);
      let factor: number;
      if (hasShare) {
        const s = w.budgetConsumed!;
        if (!(typeof s === "number" && s > 0 && s <= 1)) fail(name, `${at}.budgetConsumed must be above 0 and at most 1, got ${s}`);
        factor = Number(((s * windowMs) / longMs).toPrecision(6));
      } else {
        factor = w.factor!;
        if (!(typeof factor === "number" && Number.isFinite(factor) && factor > 0)) fail(name, `${at}.factor must be a positive number, got ${factor}`);
      }
      // An error ratio can't exceed 1, so a threshold at or above 1 never fires.
      if (factor * budget >= 1) {
        fail(name, `${at}: a burn rate of ${factor} on a budget of ${num(budget)} needs an error ratio of ${num(factor * budget)}, which can never happen`);
      }
      pairs.push({ tier, tierProps: t, long: w.long, short: w.short, factor });
    });
  }

  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.tier} ${p.long} ${p.short}`;
    if (seen.has(key)) fail(name, `alerting.${p.tier} lists the pair ${p.long}/${p.short} twice`);
    seen.add(key);
  }

  const byMs = new Map<number, string>();
  for (const p of pairs) {
    for (const w of [p.long, p.short]) {
      const ms = durationMs(w)!;
      if (!byMs.has(ms)) byMs.set(ms, w);
    }
  }
  byMs.delete(windowMs);
  const windows = [...byMs.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  windows.push(props.window);

  return { props, budget, windowMs, pairs, alertName, windows };
}

/**
 * What is wrong with an SLO's objective, window or SLI, or `undefined`.
 * `Slo()` throws with this message; the PROM003 lint rule reports it at the
 * literal in the source.
 */
export function sloPropsProblem(props: Partial<SloProps>): string | undefined {
  const o = props.objective;
  if (typeof o !== "number" || !Number.isFinite(o) || o <= 0 || o >= 1) {
    return `objective must be strictly between 0 and 1 (e.g. 0.995 for 99.5%), got ${String(o)}`;
  }
  if (!isValidDuration(props.window) || durationMs(props.window) === 0) {
    return `window must be a positive Prometheus duration (e.g. 28d or 30d), got ${JSON.stringify(props.window)}`;
  }
  const sli = props.sli as Record<string, unknown> | undefined;
  if (typeof sli !== "object" || sli === null) return "sli must set good and total, or errors and total";
  const hasGood = "good" in sli;
  const hasErrors = "errors" in sli;
  if (hasGood === hasErrors || !("total" in sli)) return "sli must set good and total, or errors and total";
  for (const key of [hasGood ? "good" : "errors", "total"]) {
    const problem = sliExprProblem(sli[key]);
    if (problem) return `sli.${key} ${problem}`;
  }
  return undefined;
}

/** What is wrong with one SLI expression, or `undefined`. */
export function sliExprProblem(expr: unknown): string | undefined {
  if (typeof expr !== "string" || expr.trim() === "") return "must be a PromQL expression";
  if (!expr.includes(SLO_WINDOW_PLACEHOLDER)) {
    return `must contain ${SLO_WINDOW_PLACEHOLDER} where the range goes, e.g. rate(x[${SLO_WINDOW_PLACEHOLDER}]), so it can be recorded per window`;
  }
  const checked = checkPromql(withWindow(expr, "5m"));
  if (!checked.ok) return `is not valid PromQL once ${SLO_WINDOW_PLACEHOLDER} is filled in: ${checked.message}`;
  return undefined;
}

function withWindow(expr: string, window: string): string {
  return expr.split(SLO_WINDOW_PLACEHOLDER).join(window);
}

function metricsOf(r: Resolved): SloMetrics {
  const { props, budget, pairs, alertName, windows } = r;
  const errorRatio: Record<string, string> = {};
  for (const w of windows) errorRatio[w] = errorRatioRecord(w);
  const burnRates: SloBurnRate[] = pairs.map((p) => ({
    tier: p.tier,
    severity: p.tierProps.severity ?? p.tier,
    long: p.long,
    short: p.short,
    factor: p.factor,
    threshold: Number((p.factor * budget).toPrecision(10)),
    longRecord: errorRatioRecord(p.long),
    shortRecord: errorRatioRecord(p.short),
    alert: alertName,
    labels: { slo: props.name, severity: p.tierProps.severity ?? p.tier, long_window: p.long, short_window: p.short },
    exhaustsIn: formatDuration(Math.round(r.windowMs / p.factor / 60_000) * 60_000),
  }));
  return {
    name: props.name,
    objective: props.objective,
    errorBudget: budget,
    window: props.window,
    labels: { slo: props.name },
    selector: `{slo="${props.name}"}`,
    windows: [...windows],
    errorRatio,
    windowErrorRatio: errorRatioRecord(props.window),
    errorBudgetRemaining: ERROR_BUDGET_REMAINING,
    objectiveRatio: OBJECTIVE_RATIO,
    burnRates,
    alertName,
    group: `slo-${props.name}`,
  };
}

function recordingRules(r: Resolved, m: SloMetrics): RecordingRule[] {
  const { props } = r;
  const sli = props.sli as { good?: string; errors?: string; total: string };
  // A window with no events records nothing: `total > 0` drops the idle
  // window's 0/0 NaN, and the SLO window's average then covers only the
  // windows that had events. The numerator falls back to `0 * total`, so a
  // window whose events were all good (or all bad) still records 0 (or 1)
  // where its own series is absent.
  const ratio = (w: string) => {
    const total = `(${withWindow(sli.total, w)}) > 0`;
    const some = (expr: string) => `((${expr}) or 0 * (${total}))`;
    return sli.errors !== undefined
      ? `${some(withWindow(sli.errors, w))}\n/\n(${total})`
      : `1 - (\n  ${some(withWindow(sli.good!, w))}\n  /\n  (${total})\n)`;
  };
  const labels = { slo: props.name };
  const rules: RecordingRule[] = [];
  const alertWindows = m.windows.slice(0, -1);
  for (const w of alertWindows) rules.push({ record: m.errorRatio[w], expr: ratio(w), labels });
  // The whole window as an average of the shortest recorded ratio, as Sloth
  // does: a range over weeks of raw counters, every evaluation, is the most
  // expensive query a rule file can hold. Without alert windows there is no
  // shorter ratio to average, so the window is read from the SLI directly.
  rules.push({
    record: m.windowErrorRatio,
    expr: alertWindows.length > 0 ? `avg_over_time(${m.errorRatio[alertWindows[0]]}${m.selector}[${props.window}])` : ratio(props.window),
    labels,
  });
  rules.push({ record: OBJECTIVE_RATIO, expr: `vector(${num(props.objective)})`, labels });
  rules.push({ record: ERROR_BUDGET_REMAINING, expr: `1 - (${m.windowErrorRatio}${m.selector} / ${num(r.budget)})`, labels });
  return rules;
}

function alertRules(r: Resolved, m: SloMetrics): AlertingRule[] {
  const { props } = r;
  return r.pairs.map((p, i) => {
    const b = m.burnRates[i];
    const cond = (record: string) => `${record}${m.selector} > (${num(p.factor)} * ${num(r.budget)})`;
    const rule: AlertingRule = {
      alert: b.alert,
      expr: `(\n  ${cond(b.longRecord)}\n)\nand\n(\n  ${cond(b.shortRecord)}\n)`,
      labels: { ...(p.tierProps.labels ?? {}), ...b.labels },
      annotations: {
        summary: `SLO ${props.name} is burning its error budget more than ${num(p.factor)}x too fast (${p.long} and ${p.short} windows)`,
        description:
          `${props.description ? `${props.description} ` : ""}The error ratio over both the last ${p.long} and the last ${p.short} is above ` +
          `${num(b.threshold)} (${num(p.factor)} times the ${num(r.budget)} budget of a ${num(props.objective)} objective). ` +
          `At that rate the ${props.window} error budget is gone in ${b.exhaustsIn}.`,
        ...(p.tierProps.annotations ?? {}),
      },
    };
    if (p.tierProps.for !== undefined) rule.for = p.tierProps.for;
    return rule;
  });
}

/**
 * An SLO, built to recording rules and multiwindow multi-burn-rate alerts.
 *
 * @example
 * ```ts
 * export const orderAck = Slo({
 *   name: "order-acknowledged",
 *   objective: 0.995,
 *   window: "28d",
 *   sli: {
 *     good: 'sum(rate(traces_span_metrics_calls_total{span_name="order.ack",status_code!="STATUS_CODE_ERROR"}[{{window}}]))',
 *     total: 'sum(rate(traces_span_metrics_calls_total{span_name="order.ack"}[{{window}}]))',
 *   },
 * });
 * // orderAck.rules is a RuleGroup; sloMetrics(orderAck) names its series.
 * ```
 */
export const Slo = Composite<SloProps, SloMembers>((props) => {
  const r = resolve(props);
  const m = metricsOf(r);
  const rules: Rule[] = [...recordingRules(r, m), ...alertRules(r, m)];
  const group = new RuleGroup({
    name: m.group,
    ...(props.interval !== undefined ? { interval: props.interval } : {}),
    ...(props.labels !== undefined ? { labels: props.labels } : {}),
    rules,
  });
  Object.defineProperty(group, SLO_METRICS, { value: m, enumerable: false });
  return { rules: group };
}, "Slo");

/**
 * The recorded series names, objective, window and burn-rate thresholds of
 * an SLO. Pass the `Slo(...)` result, its rule group, or the props
 * it was built from; a dashboard reads names from here, so renaming or
 * re-windowing the SLO moves its panels with it.
 */
export function sloMetrics(slo: SloInstance | RuleGroupEntity | SloProps): SloMetrics {
  const stashed = (x: unknown): SloMetrics | undefined =>
    typeof x === "object" && x !== null ? ((x as Record<symbol, unknown>)[SLO_METRICS] as SloMetrics | undefined) : undefined;
  const direct = stashed(slo) ?? stashed((slo as Partial<SloMembers>).rules);
  if (direct) return structuredClone(direct);
  if (typeof slo === "object" && slo !== null && "objective" in slo && "sli" in slo) return metricsOf(resolve(slo as SloProps));
  throw new Error("sloMetrics: pass an Slo(...) result, its rule group, or SLO props");
}
