/**
 * `GenAiRules`: recording rules and opt-in alerts for the otel lexicon's
 * GenAI collector preset, and spend from a price table the project declares.
 *
 * Every metric and label name comes from the `GenAiMetrics` the collector was
 * built with (`genAiMetrics(options)` or `genAiComponents(options).metrics`)
 * and from the otel lexicon's attribute keys, so a collector with another
 * namespace, or with the conventions' client metrics switched on, moves every
 * expression here with it.
 *
 * Two sources describe model calls:
 *
 * - `client`: the conventions' `gen_ai.client.operation.duration` and
 *   `gen_ai.client.token.usage` (#3041). Requests are the duration
 *   histogram's `_count`, errors the ones with an `error.type`, tokens the
 *   token histogram's `_sum` split by `gen_ai.token.type`.
 * - `spans`: the preset's own `genai.calls`, `genai.duration` and token sums.
 *   Errors are spans with `status.code` `STATUS_CODE_ERROR`. The token sums
 *   carry the model only, so cost series take the provider from the price
 *   table.
 *
 * The default is `client` when the metrics have it. Per-tool rules always
 * read the span metrics: the conventions' client metrics carry no tool name.
 *
 * Everything is in one group, recording rules first, because Prometheus
 * evaluates a group's rules in order and the later rules and the alerts read
 * the series the earlier ones record in the same evaluation.
 *
 * Cost is a rate in the price's currency per second, one series per priced
 * model and token type, labelled with the currency. A model the table does
 * not price gets no cost series, never a cost of zero. The lexicon ships no
 * prices. `currency` and `source` are required on every price, the same two
 * fields a workspace run's cost record carries (#3033), so the two can be
 * compared; chant converts no currency.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { GENAI_ATTRIBUTES, GENAI_TOKEN_TYPES, type GenAiMetric, type GenAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { prometheusLabel, SPAN_STATUS_ERROR } from "@intentius/chant-lexicon-otel/metric-names";
import { RuleGroup, type AlertingRule, type RecordingRule, type RuleGroupEntity } from "../rules";
import type { LabelSet } from "../model";
import { durationMs, isValidDuration } from "../duration";

/** One model's price, as the provider publishes it, per million tokens. */
export interface GenAiPrice {
  /** The `gen_ai.provider.name` value, e.g. `anthropic` or `openai`. */
  provider: string;
  /** The `gen_ai.request.model` value the price applies to, exactly as spans report it. */
  model: string;
  /** Price of one million input tokens. */
  inputPerMTok: number;
  /** Price of one million output tokens. */
  outputPerMTok: number;
  /** The currency the prices are in, e.g. `USD`. Required: chant converts nothing. */
  currency: string;
  /** Where the prices come from, e.g. the provider's pricing page URL. Required. */
  source: string;
  /** The date the prices were read, `YYYY-MM-DD`. */
  asOf?: string;
}

/** The fields every alert takes. */
export interface GenAiAlertOptions {
  /** How long the condition must hold (default `10m`). */
  for?: string;
  /** The `severity` label, which Alertmanager routes on (default `warning`). */
  severity?: string;
  /** More labels on the alert. */
  labels?: LabelSet;
  /** More annotations on the alert, e.g. `runbook_url`. */
  annotations?: LabelSet;
}

export interface GenAiRatioAlert extends GenAiAlertOptions {
  /** The error ratio the alert fires above, between 0 and 1. */
  threshold?: number;
}

export interface GenAiLatencyAlert extends GenAiAlertOptions {
  /** The p95 operation latency, in seconds, the alert fires above (default 30). */
  thresholdSeconds?: number;
}

/** A spending limit over the last hour or day, in one currency. */
export interface GenAiBudget extends GenAiAlertOptions {
  /** The most the window may cost, e.g. `50`. */
  amount: number;
  /** The currency of `amount`; it must be the currency of at least one price. */
  currency: string;
  /** `hour` (spend over the last hour) or `day` (the last 24 hours). */
  per: "hour" | "day";
}

/** Opt-in alerts. None is built unless it is set here. */
export interface GenAiAlerting {
  /** Error ratio per provider, model and operation (default threshold 0.05). */
  errorRatio?: true | GenAiRatioAlert;
  /** p95 operation latency per provider, model and operation (default 30s). */
  latency?: true | GenAiLatencyAlert;
  /** Error ratio per tool, from the span metrics (default threshold 0.1). */
  toolErrorRatio?: true | GenAiRatioAlert;
  /** Spend over a budget per hour or per day, from the cost rules. Needs `prices`. */
  budgets?: GenAiBudget[];
}

export interface GenAiRulesProps {
  /** The preset's metrics: `genAiMetrics(options)` with the options the collector was built with, or `genAiComponents(options)`. */
  genAi: GenAiMetrics | { metrics: GenAiMetrics };
  /** Which metrics the model rules read (default `client` when the metrics include the conventions' client metrics, else `spans`). */
  source?: "client" | "spans";
  /** Prices per provider and model. A model missing here gets no cost series. */
  prices?: GenAiPrice[];
  /** Opt-in alerts (default: none). */
  alerts?: GenAiAlerting;
  /** The rule group's name (default `genai`). */
  name?: string;
  /** The first part of every recorded series name (default `gen_ai`). */
  prefix?: string;
  /** The range every `rate` reads (default `5m`). */
  rateWindow?: string;
  /** More Prometheus labels every rule keeps, e.g. `job` or `service_name`. */
  groupBy?: string[];
  /** Labels added to every rule, e.g. `team`. */
  labels?: LabelSet;
  /** Evaluation interval of the group (default: Prometheus's `evaluation_interval`). */
  interval?: string;
}

export type GenAiRulesMembers = {
  /** The recording rules, then the alerts. */
  rules: RuleGroupEntity;
};

/** What `GenAiRules(...)` returns: its rule group, as `rules`. */
export type GenAiRulesInstance = CompositeInstance<GenAiRulesMembers> & GenAiRulesMembers;

/** A recorded latency series and the quantiles it holds, one per `quantile` label value. */
export interface GenAiQuantileSeries {
  record: string;
  /** The values of the `quantile` label, e.g. `0.95`. */
  quantiles: string[];
}

/** One alert as built. */
export interface GenAiAlertInfo {
  alert: string;
  kind: "errorRatio" | "latency" | "toolErrorRatio" | "budget";
  severity: string;
  /** The value the alert fires above: a ratio, seconds, or an amount of money. */
  threshold: number;
  /** For a budget: its currency and window. */
  currency?: string;
  per?: "hour" | "day";
}

/** The series a `GenAiRules` records, read by dashboards instead of repeating names. */
export interface GenAiRuleMetrics {
  /** The rule group's name. */
  group: string;
  /** Which metrics the model rules read. */
  source: "client" | "spans";
  rateWindow: string;
  /** Prometheus label names the series are split by. */
  labels: {
    /** Absent when the source metrics have no provider (span metrics without `providerDimensions`). */
    provider?: string;
    model: string;
    operation: string;
    errorType: string;
    tokenType: string;
    /** Absent when the span metrics have no tool dimension. */
    tool?: string;
    currency: string;
    quantile: string;
  };
  /** The labels the model series (requests, errors, latency) are split by, `groupBy` last. */
  modelLabels: string[];
  /** The labels token and cost series are split by, besides the token type (and currency on cost). */
  tokenLabels: string[];
  /** Requests per second. */
  requests: string;
  /** Errors per second, also by `error.type`. */
  errors: string;
  /** Errors over requests, 0 when there are none. */
  errorRatio: string;
  /** Errors of each `error.type` over all requests. */
  errorRatioByType: string;
  /** Operation latency in seconds, at p50, p95 and p99. */
  latency: GenAiQuantileSeries;
  /** Tokens per second, by `gen_ai.token.type` (`input`, `output`). */
  tokens: string;
  /** Spend per second in each price's currency, by token type. Absent without prices. */
  cost?: string;
  /** Per-tool series, from the span metrics. Absent when they carry no tool name. */
  tool?: {
    calls: string;
    errors: string;
    errorRatio: string;
    latency: GenAiQuantileSeries;
  };
  /** The price table as declared, without the prices. */
  prices: Array<{ provider: string; model: string; currency: string; source: string; asOf?: string }>;
  /** Every currency in the price table. */
  currencies: string[];
  /** The alerts built, in rule order. Empty unless asked for. */
  alerts: GenAiAlertInfo[];
}

const GENAI_RULES_METRICS = Symbol.for("chant.prometheus.genai");
const PREFIX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUANTILES = ["0.5", "0.95", "0.99"] as const;
const ALERT_QUANTILE = "0.95";
const CURRENCY_LABEL = "currency";
const QUANTILE_LABEL = "quantile";
const BUDGET_SECONDS = { hour: 3600, day: 86400 } as const;
const BUDGET_RANGE = { hour: "1h", day: "1d" } as const;

const DEFAULTS = {
  errorRatio: 0.05,
  latencySeconds: 30,
  toolErrorRatio: 0.1,
  for: "10m",
  severity: "warning",
};

function fail(message: string): never {
  throw new Error(`GenAiRules: ${message}`);
}

/** A number as PromQL writes it, without float noise. */
function num(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/** A label value inside a PromQL string literal. */
function quote(value: string): string {
  return JSON.stringify(value);
}

type Matcher = [label: string, op: "=" | "!=" | "=~", value: string];

function selector(metric: string, matchers: Matcher[]): string {
  if (matchers.length === 0) return metric;
  return `${metric}{${matchers.map(([l, op, v]) => `${l}${op}${quote(v)}`).join(", ")}}`;
}

function sumBy(labels: string[], inner: string): string {
  return `sum by (${labels.join(", ")}) (${inner})`;
}

function metricsOf(genAi: GenAiRulesProps["genAi"]): GenAiMetrics {
  const m = (genAi as { metrics?: GenAiMetrics })?.metrics ?? (genAi as GenAiMetrics);
  if (!m || !m.calls || !m.duration || !m.inputTokens || !m.outputTokens) {
    fail("genAi must be genAiMetrics(...) or genAiComponents(...) from the otel lexicon");
  }
  return m;
}

function has(metric: GenAiMetric, attribute: string): boolean {
  return metric.dimensions.includes(attribute);
}

function need(metric: GenAiMetric, attribute: string): string {
  if (!has(metric, attribute)) fail(`${metric.name} has no ${attribute} attribute, so the rules can't be split by it`);
  return prometheusLabel(attribute);
}

function seconds(metric: GenAiMetric): void {
  if (metric.type !== "histogram") fail(`${metric.name} is a ${metric.type}, not a histogram`);
  if (metric.unit !== "s") fail(`${metric.name} is in ${metric.unit ?? "no unit"}; the latency rules read seconds`);
}

/** How the chosen source spells requests, errors, durations and tokens. */
interface Source {
  name: "client" | "spans";
  /** The counter whose rate is requests. */
  requests: string;
  /** Matchers that select errors among requests. */
  errorMatchers: Matcher[];
  buckets: string;
  modelLabels: string[];
  provider?: string;
  /** Token rate expression per type, already summed by `tokenLabels`. */
  tokenExpr: (type: string, by: string[], window: string) => string;
  tokenLabels: string[];
  /** True when token series carry the provider label. */
  tokensHaveProvider: boolean;
}

const A = GENAI_ATTRIBUTES;

function clientSource(m: GenAiMetrics): Source {
  const c = m.client;
  if (!c) fail('source "client" needs genAiMetrics({ clientMetrics: "derive" | "passthrough" })');
  const d = c.operationDuration;
  const t = c.tokenUsage;
  seconds(d);
  const provider = need(d, A.providerName);
  const model = need(d, A.requestModel);
  const operation = need(d, A.operationName);
  const errorType = need(d, A.errorType);
  const tokenType = need(t, A.tokenType);
  const tokenLabels = [need(t, A.providerName), need(t, A.requestModel)];
  return {
    name: "client",
    requests: `${d.prometheus}_count`,
    errorMatchers: [[errorType, "!=", ""]],
    buckets: `${d.prometheus}_bucket`,
    modelLabels: [provider, model, operation],
    provider,
    tokenExpr: (type, by, window) => sumBy(by, `rate(${selector(`${t.prometheus}_sum`, [[tokenType, "=", type]])}[${window}])`),
    tokenLabels,
    tokensHaveProvider: true,
  };
}

function spanSource(m: GenAiMetrics): Source {
  seconds(m.duration);
  const status = need(m.calls, "status.code");
  const model = need(m.calls, A.requestModel);
  const operation = need(m.calls, A.operationName);
  need(m.calls, A.errorType);
  for (const a of [A.requestModel, A.operationName]) need(m.duration, a);
  const provider = has(m.calls, A.providerName) && has(m.duration, A.providerName) ? prometheusLabel(A.providerName) : undefined;
  const tokenModel = need(m.inputTokens, A.requestModel);
  need(m.outputTokens, A.requestModel);
  const tokensHaveProvider = has(m.inputTokens, A.providerName) && has(m.outputTokens, A.providerName);
  const tokenLabels = tokensHaveProvider ? [prometheusLabel(A.providerName), tokenModel] : [tokenModel];
  const byType: Record<string, GenAiMetric> = { [GENAI_TOKEN_TYPES.input]: m.inputTokens, [GENAI_TOKEN_TYPES.output]: m.outputTokens };
  return {
    name: "spans",
    requests: m.calls.prometheus,
    errorMatchers: [[status, "=", SPAN_STATUS_ERROR]],
    buckets: `${m.duration.prometheus}_bucket`,
    modelLabels: provider ? [provider, model, operation] : [model, operation],
    provider,
    tokenExpr: (type, by, window) => sumBy(by, `rate(${byType[type].prometheus}[${window}])`),
    tokenLabels,
    tokensHaveProvider,
  };
}

interface Resolved {
  props: GenAiRulesProps;
  metrics: GenAiMetrics;
  src: Source;
  prefix: string;
  window: string;
  groupBy: string[];
  /** Tool label when the span metrics carry one. */
  tool?: { label: string; status: string };
  prices: GenAiPrice[];
}

function checkAlertOptions(at: string, a: GenAiAlertOptions): void {
  if (a.for !== undefined && !isValidDuration(a.for)) fail(`${at}.for "${a.for}" is not a Prometheus duration`);
  if (a.severity !== undefined && (typeof a.severity !== "string" || a.severity === "")) fail(`${at}.severity must be a non-empty string`);
}

function checkRatio(at: string, value: unknown): void {
  if (!(typeof value === "number" && value > 0 && value < 1)) fail(`${at} must be above 0 and below 1, got ${String(value)}`);
}

function resolve(props: GenAiRulesProps): Resolved {
  if (!props || typeof props !== "object") fail("props are required");
  const metrics = metricsOf(props.genAi);
  const sourceName = props.source ?? (metrics.client ? "client" : "spans");
  if (sourceName !== "client" && sourceName !== "spans") fail(`source must be "client" or "spans", got ${JSON.stringify(sourceName)}`);
  const src = sourceName === "client" ? clientSource(metrics) : spanSource(metrics);

  const prefix = props.prefix ?? "gen_ai";
  if (!PREFIX.test(prefix)) fail(`prefix "${prefix}" must be letters, digits and '_', not starting with a digit`);
  const window = props.rateWindow ?? "5m";
  if (!isValidDuration(window) || !durationMs(window)) fail(`rateWindow "${window}" is not a positive Prometheus duration`);
  const name = props.name ?? "genai";
  if (!GROUP_NAME.test(name)) fail(`name "${name}" must be letters, digits, '.', '_' or '-'`);
  const groupBy = props.groupBy ?? [];
  for (const l of groupBy) if (!LABEL.test(l)) fail(`groupBy label "${l}" is not a Prometheus label name`);

  let tool: Resolved["tool"];
  if (has(metrics.calls, A.toolName) && has(metrics.duration, A.toolName) && has(metrics.calls, "status.code")) {
    seconds(metrics.duration);
    tool = { label: prometheusLabel(A.toolName), status: prometheusLabel("status.code") };
  }

  const prices = props.prices ?? [];
  if (!Array.isArray(prices)) fail("prices must be a list");
  const seen = new Map<string, string>();
  prices.forEach((p, i) => {
    const at = `prices[${i}]`;
    for (const k of ["provider", "model", "currency", "source"] as const) {
      if (typeof p?.[k] !== "string" || p[k].trim() === "") fail(`${at}.${k} is required`);
    }
    for (const k of ["inputPerMTok", "outputPerMTok"] as const) {
      const v = p[k];
      if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) fail(`${at}.${k} must be a number at or above 0, got ${String(v)}`);
    }
    if (p.asOf !== undefined && !DATE.test(p.asOf)) fail(`${at}.asOf must be a date, YYYY-MM-DD, got ${JSON.stringify(p.asOf)}`);
    // Without a provider on the token series, one model priced twice can't be told apart.
    const k = src.tokensHaveProvider ? `${p.provider}\u0000${p.model}` : p.model;
    const before = seen.get(k);
    if (before !== undefined) {
      fail(
        src.tokensHaveProvider
          ? `${at} prices ${p.provider} ${p.model} again (first at ${before})`
          : `${at} prices model ${p.model} again (first at ${before}); the ${src.name} token metrics have no provider to tell them apart`,
      );
    }
    seen.set(k, at);
  });

  const alerts = props.alerts ?? {};
  const ratioAlert = (key: "errorRatio" | "toolErrorRatio") => {
    const a = alerts[key];
    if (a === undefined) return;
    if (a !== true) {
      checkAlertOptions(`alerts.${key}`, a);
      if (a.threshold !== undefined) checkRatio(`alerts.${key}.threshold`, a.threshold);
    }
  };
  ratioAlert("errorRatio");
  ratioAlert("toolErrorRatio");
  if (alerts.toolErrorRatio !== undefined && !tool) fail(`alerts.toolErrorRatio needs span metrics with a ${A.toolName} attribute`);
  if (alerts.latency !== undefined && alerts.latency !== true) {
    checkAlertOptions("alerts.latency", alerts.latency);
    const s = alerts.latency.thresholdSeconds;
    if (s !== undefined && !(typeof s === "number" && Number.isFinite(s) && s > 0)) fail(`alerts.latency.thresholdSeconds must be above 0, got ${String(s)}`);
  }
  const currencies = new Set(prices.map((p) => p.currency));
  const budgets = new Map<string, string>();
  if (alerts.budgets !== undefined && !Array.isArray(alerts.budgets)) fail("alerts.budgets must be a list");
  (alerts.budgets ?? []).forEach((b, i) => {
    const at = `alerts.budgets[${i}]`;
    const k = `${b?.per} ${b?.currency}`;
    if (budgets.has(k)) fail(`${at} sets a second budget per ${b.per} in ${b.currency} (first at ${budgets.get(k)})`);
    budgets.set(k, at);
    checkAlertOptions(at, b);
    if (!(typeof b.amount === "number" && Number.isFinite(b.amount) && b.amount > 0)) fail(`${at}.amount must be above 0, got ${String(b.amount)}`);
    if (b.per !== "hour" && b.per !== "day") fail(`${at}.per must be "hour" or "day", got ${JSON.stringify(b.per)}`);
    if (!currencies.has(b.currency)) {
      fail(`${at}.currency ${JSON.stringify(b.currency)} is the currency of no price, so nothing could be spent in it`);
    }
  });

  return { props, metrics, src, prefix, window, groupBy, tool, prices };
}

function metricsFor(r: Resolved): GenAiRuleMetrics {
  const { prefix: p, window: w, src, groupBy, tool, prices, props } = r;
  const rec = (what: string) => `${p}:${what}:rate${w}`;
  const alerts = props.alerts ?? {};
  const info: GenAiAlertInfo[] = [];
  const sev = (a: true | GenAiAlertOptions) => (a === true ? undefined : a.severity) ?? DEFAULTS.severity;
  if (alerts.errorRatio !== undefined) {
    const a = alerts.errorRatio;
    info.push({ alert: "GenAiErrorRatioHigh", kind: "errorRatio", severity: sev(a), threshold: (a === true ? undefined : a.threshold) ?? DEFAULTS.errorRatio });
  }
  if (alerts.latency !== undefined) {
    const a = alerts.latency;
    info.push({ alert: "GenAiLatencyHigh", kind: "latency", severity: sev(a), threshold: (a === true ? undefined : a.thresholdSeconds) ?? DEFAULTS.latencySeconds });
  }
  if (alerts.toolErrorRatio !== undefined) {
    const a = alerts.toolErrorRatio;
    info.push({ alert: "GenAiToolErrorRatioHigh", kind: "toolErrorRatio", severity: sev(a), threshold: (a === true ? undefined : a.threshold) ?? DEFAULTS.toolErrorRatio });
  }
  for (const b of alerts.budgets ?? []) {
    info.push({ alert: "GenAiSpendOverBudget", kind: "budget", severity: b.severity ?? DEFAULTS.severity, threshold: b.amount, currency: b.currency, per: b.per });
  }
  return {
    group: props.name ?? "genai",
    source: src.name,
    rateWindow: w,
    labels: {
      ...(src.provider ? { provider: src.provider } : {}),
      model: prometheusLabel(A.requestModel),
      operation: prometheusLabel(A.operationName),
      errorType: prometheusLabel(A.errorType),
      tokenType: prometheusLabel(A.tokenType),
      ...(tool ? { tool: tool.label } : {}),
      currency: CURRENCY_LABEL,
      quantile: QUANTILE_LABEL,
    },
    modelLabels: [...src.modelLabels, ...groupBy],
    tokenLabels: [...src.tokenLabels, ...groupBy],
    requests: rec("requests"),
    errors: rec("errors"),
    errorRatio: rec("error_ratio"),
    errorRatioByType: rec("error_ratio_by_type"),
    latency: { record: `${p}:operation_duration_seconds:quantile_rate${w}`, quantiles: [...QUANTILES] },
    tokens: rec("tokens"),
    ...(prices.length > 0 ? { cost: rec("cost") } : {}),
    ...(tool
      ? {
          tool: {
            calls: rec("tool_calls"),
            errors: rec("tool_errors"),
            errorRatio: rec("tool_error_ratio"),
            latency: { record: `${p}:tool_duration_seconds:quantile_rate${w}`, quantiles: [ALERT_QUANTILE] },
          },
        }
      : {}),
    prices: prices.map((x) => ({ provider: x.provider, model: x.model, currency: x.currency, source: x.source, ...(x.asOf ? { asOf: x.asOf } : {}) })),
    currencies: [...new Set(prices.map((x) => x.currency))],
    alerts: info,
  };
}

function recordingRules(r: Resolved, m: GenAiRuleMetrics): RecordingRule[] {
  const { src, window: w, metrics, tool, prices } = r;
  const model = m.labels.model;
  const errorType = m.labels.errorType;
  const tokenType = m.labels.tokenType;
  // Spans without a model (tool calls, in-process agent steps) aren't model requests.
  const scope: Matcher[] = [[model, "!=", ""]];
  const rate = (metric: string, matchers: Matcher[]) => `rate(${selector(metric, matchers)}[${w}])`;
  const rules: RecordingRule[] = [];

  rules.push({ record: m.requests, expr: sumBy(m.modelLabels, rate(src.requests, scope)) });
  rules.push({ record: m.errors, expr: sumBy([...m.modelLabels, errorType], rate(src.requests, [...scope, ...src.errorMatchers])) });
  // `or 0 * requests` makes the ratio 0, not absent, for a model with no errors yet.
  rules.push({ record: m.errorRatio, expr: `(\n  sum without (${errorType}) (${m.errors})\n  or\n  0 * ${m.requests}\n)\n/\n${m.requests}` });
  rules.push({ record: m.errorRatioByType, expr: `${m.errors}\n/ ignoring (${errorType}) group_left\n${m.requests}` });
  for (const q of QUANTILES) {
    rules.push({
      record: m.latency.record,
      expr: `histogram_quantile(${q}, ${sumBy([...m.modelLabels, "le"], rate(src.buckets, scope))})`,
      labels: { [QUANTILE_LABEL]: q },
    });
  }
  for (const type of [GENAI_TOKEN_TYPES.input, GENAI_TOKEN_TYPES.output]) {
    rules.push({ record: m.tokens, expr: src.tokenExpr(type, m.tokenLabels, w), labels: { [tokenType]: type } });
  }

  if (m.cost) {
    const provider = prometheusLabel(A.providerName);
    for (const price of prices) {
      const of = (type: string, perMTok: number) => {
        const ms: Matcher[] = [[model, "=", price.model], [tokenType, "=", type]];
        if (src.tokensHaveProvider) ms.unshift([provider, "=", price.provider]);
        return `${selector(m.tokens, ms)} * ${num(perMTok)} / 1000000`;
      };
      rules.push({
        record: m.cost,
        expr: `${of(GENAI_TOKEN_TYPES.input, price.inputPerMTok)}\nor\n${of(GENAI_TOKEN_TYPES.output, price.outputPerMTok)}`,
        // Provider and model as rule labels too: they tell the cost rules apart (PROM102), and
        // carry the provider onto span token sums, which have none.
        labels: { [provider]: price.provider, [model]: price.model, [CURRENCY_LABEL]: price.currency },
      });
    }
  }

  if (tool && m.tool) {
    const t = m.tool;
    const toolScope: Matcher[] = [[tool.label, "!=", ""]];
    const by = [tool.label, ...r.groupBy];
    rules.push({ record: t.calls, expr: sumBy(by, rate(metrics.calls.prometheus, toolScope)) });
    rules.push({ record: t.errors, expr: sumBy(by, rate(metrics.calls.prometheus, [...toolScope, [tool.status, "=", SPAN_STATUS_ERROR]])) });
    rules.push({ record: t.errorRatio, expr: `(\n  ${t.errors}\n  or\n  0 * ${t.calls}\n)\n/\n${t.calls}` });
    rules.push({
      record: t.latency.record,
      expr: `histogram_quantile(${ALERT_QUANTILE}, ${sumBy([...by, "le"], rate(`${metrics.duration.prometheus}_bucket`, toolScope))})`,
      labels: { [QUANTILE_LABEL]: ALERT_QUANTILE },
    });
  }
  return rules;
}

function alertRules(r: Resolved, m: GenAiRuleMetrics): AlertingRule[] {
  const alerts = r.props.alerts ?? {};
  const l = m.labels;
  const who = `{{ $labels.${l.model} }}${l.provider ? ` ({{ $labels.${l.provider} }})` : ""} {{ $labels.${l.operation} }}`;
  const out: AlertingRule[] = [];
  const build = (a: true | GenAiAlertOptions, info: GenAiAlertInfo, expr: string, summary: string, description: string, extra: LabelSet = {}) => {
    const o: GenAiAlertOptions = a === true ? {} : a;
    out.push({
      alert: info.alert,
      expr,
      for: o.for ?? DEFAULTS.for,
      labels: { ...(o.labels ?? {}), ...extra, severity: info.severity },
      annotations: { summary, description, ...(o.annotations ?? {}) },
    });
  };
  const byKind = (k: GenAiAlertInfo["kind"]) => m.alerts.filter((x) => x.kind === k);

  if (alerts.errorRatio !== undefined) {
    const info = byKind("errorRatio")[0];
    build(
      alerts.errorRatio,
      info,
      `${m.errorRatio} > ${num(info.threshold)}`,
      `GenAI error ratio above ${num(info.threshold * 100)}% for ${who}`,
      `{{ $value | humanizePercentage }} of ${who} requests failed over the last ${r.window}.`,
    );
  }
  if (alerts.latency !== undefined) {
    const info = byKind("latency")[0];
    build(
      alerts.latency,
      info,
      `${selector(m.latency.record, [[QUANTILE_LABEL, "=", ALERT_QUANTILE]])} > ${num(info.threshold)}`,
      `GenAI p95 latency above ${num(info.threshold)}s for ${who}`,
      `p95 latency of ${who} is {{ $value | humanizeDuration }} over the last ${r.window}.`,
    );
  }
  if (alerts.toolErrorRatio !== undefined && m.tool) {
    const info = byKind("toolErrorRatio")[0];
    const tool = `{{ $labels.${l.tool} }}`;
    build(
      alerts.toolErrorRatio,
      info,
      `${m.tool.errorRatio} > ${num(info.threshold)}`,
      `Tool ${tool} error ratio above ${num(info.threshold * 100)}%`,
      `{{ $value | humanizePercentage }} of calls to tool ${tool} failed over the last ${r.window}.`,
    );
  }
  (alerts.budgets ?? []).forEach((b, i) => {
    const info = byKind("budget")[i];
    // The average of the recorded per-second rate over the window, times its length, is what the window cost.
    const spend = `sum by (${CURRENCY_LABEL}) (avg_over_time(${selector(m.cost!, [[CURRENCY_LABEL, "=", b.currency]])}[${BUDGET_RANGE[b.per]}])) * ${BUDGET_SECONDS[b.per]}`;
    build(
      { for: "0s", ...b },
      info,
      `${spend} > ${num(b.amount)}`,
      `GenAI spend over the ${b.per === "hour" ? "hourly" : "daily"} budget of ${num(b.amount)} ${b.currency}`,
      `Model calls cost {{ $value | printf "%.2f" }} ${b.currency} over the last ${BUDGET_RANGE[b.per]}, above the budget of ${num(b.amount)}. Models without a price are not counted.`,
      { budget: b.per, [CURRENCY_LABEL]: b.currency },
    );
  });
  // A for of 0s says nothing; leave it out.
  for (const rule of out) if (rule.for === "0s") delete rule.for;
  return out;
}

/**
 * Recording rules and opt-in alerts for GenAI calls, from the otel preset's metrics.
 *
 * @example
 * ```ts
 * import { genAiMetrics } from "@intentius/chant-lexicon-otel";
 * import { GenAiRules } from "@intentius/chant-lexicon-prometheus";
 *
 * export const genai = GenAiRules({
 *   genAi: genAiMetrics({ clientMetrics: "derive" }),
 *   prices: [{ provider: "anthropic", model: "claude-x", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com/pricing", asOf: "2026-09-29" }],
 *   alerts: { errorRatio: true, budgets: [{ amount: 50, currency: "USD", per: "day" }] },
 * });
 * // genai.rules is a RuleGroup; genAiRuleMetrics(genai) names its series.
 * ```
 */
export const GenAiRules = Composite<GenAiRulesProps, GenAiRulesMembers>((props) => {
  const r = resolve(props);
  const m = metricsFor(r);
  const group = new RuleGroup({
    name: m.group,
    ...(props.interval !== undefined ? { interval: props.interval } : {}),
    ...(props.labels !== undefined ? { labels: props.labels } : {}),
    rules: [...recordingRules(r, m), ...alertRules(r, m)],
  });
  Object.defineProperty(group, GENAI_RULES_METRICS, { value: m, enumerable: false });
  return { rules: group };
}, "GenAiRules");

/**
 * The series a `GenAiRules` records and the alerts it builds. Pass the
 * `GenAiRules(...)` result, its rule group, or the props it was built from;
 * a dashboard reads names from here instead of repeating them.
 */
export function genAiRuleMetrics(rules: GenAiRulesInstance | RuleGroupEntity | GenAiRulesProps): GenAiRuleMetrics {
  const stashed = (x: unknown): GenAiRuleMetrics | undefined =>
    typeof x === "object" && x !== null ? ((x as Record<symbol, unknown>)[GENAI_RULES_METRICS] as GenAiRuleMetrics | undefined) : undefined;
  const direct = stashed(rules) ?? stashed((rules as Partial<GenAiRulesMembers>)?.rules);
  if (direct) return structuredClone(direct);
  if (typeof rules === "object" && rules !== null && "genAi" in rules) return metricsFor(resolve(rules as GenAiRulesProps));
  throw new Error("genAiRuleMetrics: pass a GenAiRules(...) result, its rule group, or GenAiRules props");
}
