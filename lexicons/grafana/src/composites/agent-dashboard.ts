/**
 * `AgentDashboard`: latency and errors per model and per tool, and token
 * usage per model, from the otel lexicon's GenAI preset.
 *
 * Two modes:
 *
 * - `genAi`: the preset's span metrics, read directly. Metric names come from
 *   `genAiMetrics()` (or the `metrics` of `genAiComponents()`), and label
 *   names from the preset's GenAI attribute keys, so a preset with another
 *   `namespace` moves every query here.
 * - `rules`: the series the prometheus lexicon's `GenAiRules` records, named
 *   by `genAiRuleMetrics()`. These follow the conventions' client metrics
 *   when the collector emits them (#3041), and add a provider breakdown, cost
 *   from the declared price table and the alerts. Opt-in: a dashboard given
 *   only `genAi` is built exactly as before.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { GENAI_ATTRIBUTES, GENAI_TOKEN_TYPES, type GenAiMetric, type GenAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { prometheusLabel, SPAN_STATUS_ERROR } from "@intentius/chant-lexicon-otel/metric-names";
import { genAiRuleMetrics, type GenAiRuleMetrics, type GenAiRulesInstance } from "@intentius/chant-lexicon-prometheus/composites/genai";
import type { RuleGroupEntity } from "@intentius/chant-lexicon-prometheus/rules";
import { GRAFANA_UNIT_IDS } from "../spec/units.gen";
import { Dashboard, type DashboardEntity } from "../dashboard";
import { Row, StatPanel, TimeSeriesPanel, type RowEntity } from "../panels";
import { PromQuery } from "../query";
import { QueryVariable } from "../variables";
import { slugUid } from "../util";
import {
  dashboardProps,
  durationUnit,
  errorRatio,
  legend,
  num,
  quantile,
  quantileName,
  requireDatasource,
  selector,
  sumRate,
  type DashboardOptions,
  type Matcher,
} from "./shared";

export interface AgentDashboardProps extends DashboardOptions {
  /** The preset's metrics: `genAiMetrics(options)` with the options the collector was built with, or `genAiComponents(options)`. Required unless `rules` is given. */
  genAi?: GenAiMetrics | { metrics: GenAiMetrics };
  /**
   * Read the series a prometheus `GenAiRules` records instead of the preset's metrics: the `GenAiRules(...)` result, its rule group, or `genAiRuleMetrics(...)` of it. Adds a provider breakdown, cost per currency and the alerts. Give `genAi` or `rules`, not both. For a service picker, build the rules with `groupBy: ["service_name"]` or `["job"]`.
   */
  rules?: GenAiRulesInstance | RuleGroupEntity | GenAiRuleMetrics;
  /** The latency quantile per model and per tool (default 0.95). With `rules`, one the rules record: 0.5, 0.95 or 0.99. */
  quantile?: number;
}

export type AgentDashboardMembers = { dashboard: DashboardEntity };

/** What `AgentDashboard(...)` returns: its dashboard, as `dashboard`. */
export type AgentDashboardInstance = CompositeInstance<AgentDashboardMembers> & AgentDashboardMembers;

function metricsOf(genAi: AgentDashboardProps["genAi"]): GenAiMetrics {
  const m = (genAi as { metrics?: GenAiMetrics }).metrics ?? (genAi as GenAiMetrics);
  if (!m || !m.calls || !m.duration || !m.inputTokens || !m.outputTokens) {
    throw new Error("AgentDashboard: genAi must be genAiMetrics(...) or genAiComponents(...) from the otel lexicon");
  }
  return m;
}

function labelOf(metric: GenAiMetric, attribute: string): string {
  if (!metric.dimensions.includes(attribute)) {
    throw new Error(`AgentDashboard: ${metric.name} has no ${attribute} dimension, so it can't be broken down by it`);
  }
  return prometheusLabel(attribute);
}

/** The PromQL the agent dashboard runs, from the preset's metrics. Exposed for tests and for panels of your own. */
export function agentQueries(m: GenAiMetrics, q = 0.95) {
  const model = labelOf(m.calls, GENAI_ATTRIBUTES.requestModel);
  const tool = labelOf(m.calls, GENAI_ATTRIBUTES.toolName);
  const errorType = labelOf(m.calls, GENAI_ATTRIBUTES.errorType);
  const status = labelOf(m.calls, "status.code");
  const service = labelOf(m.calls, "service.name");
  labelOf(m.duration, GENAI_ATTRIBUTES.requestModel);
  labelOf(m.duration, GENAI_ATTRIBUTES.toolName);
  const tokenModel = labelOf(m.inputTokens, GENAI_ATTRIBUTES.requestModel);
  labelOf(m.outputTokens, GENAI_ATTRIBUTES.requestModel);

  const scope: Matcher[] = [
    [service, "=~", "$service"],
    [model, "=~", "$model"],
  ];
  const toolScope: Matcher[] = [...scope, [tool, "!=", ""]];
  const err: Matcher = [status, "=", SPAN_STATUS_ERROR];
  const calls = m.calls.prometheus;
  const buckets = `${m.duration.prometheus}_bucket`;
  const ratio = (matchers: Matcher[], by: string[]) => errorRatio(selector(calls, [...matchers, err]), selector(calls, matchers), by);
  const tokens: Matcher[] = [[tokenModel, "=~", "$model"]];

  return {
    labels: { model, tool, errorType, status, service, tokenModel },
    services: `label_values(${calls}, ${service})`,
    models: `label_values(${calls}, ${model})`,
    model: {
      rate: sumRate(selector(calls, scope), [model]),
      errorRatio: ratio(scope, [model]),
      latency: quantile(q, selector(buckets, scope), [model]),
    },
    tool: {
      rate: sumRate(selector(calls, toolScope), [tool]),
      errorRatio: ratio(toolScope, [tool]),
      latency: quantile(q, selector(buckets, toolScope), [tool]),
    },
    errorsByType: sumRate(selector(calls, [...scope, err]), [errorType]),
    tokens: {
      inputRate: sumRate(selector(m.inputTokens.prometheus, tokens), [tokenModel]),
      outputRate: sumRate(selector(m.outputTokens.prometheus, tokens), [tokenModel]),
      inputTotal: `sum(increase(${selector(m.inputTokens.prometheus, tokens)}[$__range]))`,
      outputTotal: `sum(increase(${selector(m.outputTokens.prometheus, tokens)}[$__range]))`,
    },
  };
}

// ── From GenAiRules ─────────────────────────────────────────────

/** The labels a `$service` picker can read, in the order they're preferred. */
const SERVICE_LABELS = ["service_name", "job"];
const SECONDS_PER_HOUR = 3600;

function isRuleMetrics(x: unknown): x is GenAiRuleMetrics {
  return typeof x === "object" && x !== null && "requests" in x && "modelLabels" in x && "tokenLabels" in x && "latency" in x;
}

function ruleMetricsOf(rules: NonNullable<AgentDashboardProps["rules"]>): GenAiRuleMetrics {
  if (isRuleMetrics(rules)) return rules;
  try {
    return genAiRuleMetrics(rules as GenAiRulesInstance);
  } catch {
    throw new Error("AgentDashboard: rules must be a GenAiRules(...) result, its rule group, or genAiRuleMetrics(...) from the prometheus lexicon");
  }
}

/** `sum by (labels) (sel)`, or `sum (sel)` with no labels. */
function sumOf(sel: string, by: string[]): string {
  return `sum${by.length ? ` by (${by.join(", ")})` : ""} (${sel})`;
}

/** Errors over requests, both already per-second series, padded to 0 like `errorRatio`. */
function recordedRatio(errorSel: string, allSel: string, by: string[]): string {
  const all = sumOf(allSel, by);
  return `(\n${sumOf(errorSel, by)}\nor\n${all} * 0\n)\n/\n${all}`;
}

/** A recorded per-second rate summed over the dashboard's range: its average over the range times the range's seconds. */
function overRange(sel: string): string {
  return `sum(avg_over_time(${sel}[$__range])) * $__range_s`;
}

/**
 * The PromQL the rules-mode agent dashboard runs, from `genAiRuleMetrics()`.
 * Exposed for tests and for panels of your own.
 *
 * Every series is a recorded one, so nothing here takes a `rate`. Cost is
 * one query per currency: amounts in two currencies are never added.
 */
export function agentRuleQueries(m: GenAiRuleMetrics, q = 0.95) {
  const quantileValue = num(q);
  if (!m.latency.quantiles.includes(quantileValue)) {
    throw new Error(`AgentDashboard: the rules record latency at ${m.latency.quantiles.join(", ")}, not ${quantileValue}`);
  }
  const l = m.labels;
  const service = SERVICE_LABELS.find((x) => m.modelLabels.includes(x) && m.tokenLabels.includes(x));
  const provider = l.provider;
  const tokensHaveProvider = provider !== undefined && m.tokenLabels.includes(provider);
  // Cost series carry the price's provider as a rule label, whatever the token series have.
  const costProvider = prometheusLabel(GENAI_ATTRIBUTES.providerName);

  const svc: Matcher[] = service ? [[service, "=~", "$service"]] : [];
  const prov: Matcher[] = provider ? [[provider, "=~", "$provider"]] : [];
  const modelMatch: Matcher = [l.model, "=~", "$model"];
  const scope: Matcher[] = [...svc, ...prov, modelMatch];
  const tokenScope: Matcher[] = [...svc, ...(tokensHaveProvider ? prov : []), modelMatch];
  const modelBy = [...(provider ? [provider] : []), l.model, l.operation];
  const tokenBy = [...(tokensHaveProvider ? [provider!] : []), l.model];
  const tokens = (type: string) => selector(m.tokens, [...tokenScope, [l.tokenType, "=", type]]);
  const requests = selector(m.requests, scope);
  const errors = selector(m.errors, scope);

  return {
    labels: { ...(service ? { service } : {}), ...l, modelBy, tokenBy },
    variables: {
      ...(service ? { services: `label_values(${m.requests}, ${service})` } : {}),
      ...(provider ? { providers: `label_values(${selector(m.requests, svc)}, ${provider})` } : {}),
      models: `label_values(${selector(m.requests, [...svc, ...prov])}, ${l.model})`,
    },
    model: {
      rate: sumOf(requests, modelBy),
      errorRatio: recordedRatio(errors, requests, modelBy),
      latency: selector(m.latency.record, [...scope, [l.quantile, "=", quantileValue]]),
    },
    ...(provider
      ? {
          provider: {
            rate: sumOf(requests, [provider]),
            errorRatio: recordedRatio(errors, requests, [provider]),
            ...(tokensHaveProvider ? { tokens: sumOf(selector(m.tokens, tokenScope), [provider, l.tokenType]) } : {}),
          },
        }
      : {}),
    ...(m.tool && l.tool
      ? {
          tool: {
            rate: sumOf(selector(m.tool.calls, svc), [l.tool]),
            errorRatio: recordedRatio(selector(m.tool.errors, svc), selector(m.tool.calls, svc), [l.tool]),
            latency: selector(m.tool.latency.record, [...svc, [l.quantile, "=", m.tool.latency.quantiles[0]]]),
            quantile: Number(m.tool.latency.quantiles[0]),
          },
        }
      : {}),
    errorsByType: sumOf(errors, [l.errorType]),
    tokens: {
      inputRate: sumOf(tokens(GENAI_TOKEN_TYPES.input), tokenBy),
      outputRate: sumOf(tokens(GENAI_TOKEN_TYPES.output), tokenBy),
      inputTotal: overRange(tokens(GENAI_TOKEN_TYPES.input)),
      outputTotal: overRange(tokens(GENAI_TOKEN_TYPES.output)),
    },
    cost: m.cost
      ? m.currencies.map((currency) => {
          const sel = selector(m.cost!, [...svc, ...prov, modelMatch, [l.currency, "=", currency]]);
          return {
            currency,
            perHour: `${sumOf(sel, [costProvider, l.model])} * ${SECONDS_PER_HOUR}`,
            total: overRange(sel),
          };
        })
      : [],
    ...(m.alerts.length > 0
      ? {
          alertsFiring: `sum(${selector("ALERTS", [
            ["alertname", "=~", [...new Set(m.alerts.map((a) => a.alert))].join("|")],
            ["alertstate", "=", "firing"],
          ])}) or vector(0)`,
        }
      : {}),
  };
}

/** Grafana's unit for an amount in `currency`, or plain numbers for one it has no unit for. */
function currencyUnit(currency: string): string {
  const id = `currency${currency}`;
  return GRAFANA_UNIT_IDS.includes(id) ? id : "short";
}

/** `prices as of 2026-09-29`, or a span of dates when the prices were read on different days. */
function asOfText(dates: string[]): string | undefined {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return undefined;
  return sorted.length === 1 ? `prices as of ${sorted[0]}` : `prices as of ${sorted[0]} to ${sorted[sorted.length - 1]}`;
}

function rulesDashboard(props: AgentDashboardProps, m: GenAiRuleMetrics): DashboardEntity {
  const qv = props.quantile ?? 0.95;
  if (!(typeof qv === "number" && qv > 0 && qv < 1)) throw new Error(`AgentDashboard: quantile must be between 0 and 1, got ${String(qv)}`);
  const q = agentRuleQueries(m, qv);
  const ds = props.datasource;
  const p = quantileName(qv);
  const { labels } = q;

  const variable = (name: string, label: string, query: string) =>
    new QueryVariable({ name, label, datasource: ds, query, multi: true, includeAll: true, allValue: ".*", refresh: "onTimeRangeChange", sort: 1 });
  const variables = [
    ...(q.variables.services ? [variable("service", "Service", q.variables.services)] : []),
    ...(q.variables.providers ? [variable("provider", "Provider", q.variables.providers)] : []),
    variable("model", "Model", q.variables.models),
  ];

  const series = (title: string, expr: string, by: string[], unit: string, description: string, w = 8) =>
    new TimeSeriesPanel({
      title,
      description,
      datasource: ds,
      gridPos: { w, h: 8 },
      targets: [new PromQuery({ expr, legendFormat: legend(...by) })],
      fieldConfig: { defaults: { unit, ...(unit === "percentunit" ? { min: 0 } : {}) } },
    });
  // One instant query at the end of the range, as in the span-metrics mode.
  const stat = (title: string, expr: string, unit: string, description: string, w = 4, legendFormat = title) =>
    new StatPanel({
      title,
      description,
      datasource: ds,
      gridPos: { w, h: 8 },
      targets: [new PromQuery({ expr, legendFormat, instant: true, range: false })],
      options: { graphMode: "none", colorMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
      fieldConfig: { defaults: { unit, decimals: unit === "short" ? 0 : 2 } },
    });
  const withService = (by: string[]) => (labels.service ? [...by, labels.service] : by);

  const rows: RowEntity[] = [];
  rows.push(
    new Row({
      title: "Models",
      panels: [
        series("Requests by model", q.model.rate, labels.modelBy, "reqps", `Model requests per second, from ${m.requests}.`),
        series("Errors by model", q.model.errorRatio, labels.modelBy, "percentunit", `Share of model requests that failed, from ${m.errors} over ${m.requests}.`),
        series(
          `Latency ${p} by model`,
          q.model.latency,
          withService(labels.modelBy),
          "s",
          `Recorded per ${m.modelLabels.join(", ")} in ${m.latency.record}; a quantile can't be summed, so each of those is its own line.`,
        ),
      ],
    }),
  );
  if (q.provider && labels.provider) {
    rows.push(
      new Row({
        title: "Providers",
        panels: [
          series("Requests by provider", q.provider.rate, [labels.provider], "reqps", `Model requests per second by ${GENAI_ATTRIBUTES.providerName}.`),
          series("Errors by provider", q.provider.errorRatio, [labels.provider], "percentunit", "Share of model requests that failed, by provider."),
          ...(q.provider.tokens
            ? [series("Tokens by provider", q.provider.tokens, [labels.provider, labels.tokenType], "short", `Tokens per second by provider and ${GENAI_ATTRIBUTES.tokenType}.`)]
            : []),
        ],
      }),
    );
  }
  if (q.tool && labels.tool) {
    rows.push(
      new Row({
        title: "Tools",
        panels: [
          series("Tool calls", q.tool.rate, [labels.tool], "reqps", `Calls per tool per second, from ${m.tool!.calls}.`),
          series("Errors by tool", q.tool.errorRatio, [labels.tool], "percentunit", `Share of tool calls that failed, from ${m.tool!.errors} over ${m.tool!.calls}.`),
          series(`Latency ${quantileName(q.tool.quantile)} by tool`, q.tool.latency, withService([labels.tool]), "s", `From ${m.tool!.latency.record}.`),
        ],
      }),
    );
  }
  rows.push(
    new Row({
      title: "Errors",
      panels: [
        series(
          "Errors by type",
          q.errorsByType,
          [labels.errorType],
          "reqps",
          `Failed model requests per second by ${GENAI_ATTRIBUTES.errorType}, from ${m.errors}.`,
          q.alertsFiring ? 20 : 24,
        ),
        ...(q.alertsFiring
          ? [
              stat(
                "GenAI alerts firing",
                q.alertsFiring,
                "short",
                `Firing alerts of the ${m.group} rule group: ${[...new Set(m.alerts.map((a) => a.alert))].join(", ")}.`,
              ),
            ]
          : []),
      ],
    }),
  );
  const tokenNote = `Over the dashboard's time range, from ${m.tokens}.`;
  rows.push(
    new Row({
      title: "Tokens",
      panels: [
        series("Input tokens by model", q.tokens.inputRate, labels.tokenBy, "short", `Input tokens per second by model, from ${m.tokens}.`),
        series("Output tokens by model", q.tokens.outputRate, labels.tokenBy, "short", `Output tokens per second by model, from ${m.tokens}.`),
        stat("Input tokens", q.tokens.inputTotal, "short", tokenNote),
        stat("Output tokens", q.tokens.outputTotal, "short", tokenNote),
      ],
    }),
  );
  if (q.cost.length > 0) {
    const panels = q.cost.flatMap((c) => {
      const prices = m.prices.filter((x) => x.currency === c.currency);
      const asOf = asOfText(prices.flatMap((x) => (x.asOf ? [x.asOf] : [])));
      const note =
        `From ${m.cost} and the declared prices in ${c.currency}${asOf ? `, ${asOf}` : ""} (${[...new Set(prices.map((x) => x.source))].join(", ")}). ` +
        `Models without a price are not counted, and amounts in other currencies are shown apart, never added.`;
      const unit = currencyUnit(c.currency);
      return [
        series(`Spend per hour in ${c.currency}`, c.perHour, [prometheusLabel(GENAI_ATTRIBUTES.providerName), labels.model], unit, note, 16),
        stat(`Spend in ${c.currency}${asOf ? `, ${asOf}` : ""}`, c.total, unit, `Over the dashboard's time range. ${note}`, 8, c.currency),
      ];
    });
    rows.push(new Row({ title: "Cost", panels }));
  }

  const noService = labels.service ? "" : " Build the rules with groupBy service_name or job for a service picker.";
  return new Dashboard({
    ...dashboardProps(props, {
      title: q.cost.length > 0 ? "Agents: models, tools, tokens and cost" : "Agents: models, tools and tokens",
      uid: slugUid(`${m.group}-agents`),
      description: `Requests, errors and latency per model${labels.provider ? " and provider" : ""}${q.tool ? " and tool" : ""}, tokens${q.cost.length > 0 ? " and cost" : ""}, from the ${m.group} GenAI recording rules (${m.source} metrics).${noService}`,
      tags: ["genai", "agents"],
    }),
    variables,
    panels: rows,
  });
}

/**
 * A dashboard for agents instrumented with GenAI spans: calls, errors and
 * latency per model and per tool, errors by type, and token usage per
 * model, from the GenAI preset's metrics.
 *
 * @example
 * ```ts
 * import { genAiMetrics } from "@intentius/chant-lexicon-otel";
 * import { AgentDashboard } from "@intentius/chant-lexicon-grafana";
 *
 * export const agents = AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus });
 *
 * // Or from the prometheus lexicon's GenAiRules, with provider, cost and alerts:
 * export const genai = GenAiRules({ genAi: genAiMetrics({ clientMetrics: "derive" }), prices, groupBy: ["service_name"] });
 * export const agentRules = AgentDashboard({ rules: genai, datasource: prometheus });
 * ```
 */
export const AgentDashboard = Composite<AgentDashboardProps, AgentDashboardMembers>((props) => {
  requireDatasource("AgentDashboard", props.datasource);
  if (props.rules !== undefined) {
    if (props.genAi !== undefined) throw new Error("AgentDashboard: give genAi or rules, not both; the rules already read the preset's metrics");
    return { dashboard: rulesDashboard(props, ruleMetricsOf(props.rules)) };
  }
  if (!props.genAi) throw new Error("AgentDashboard: genAi is required (genAiMetrics(...) from the otel lexicon)");
  const m = metricsOf(props.genAi);
  const qv = props.quantile ?? 0.95;
  if (!(typeof qv === "number" && qv > 0 && qv < 1)) throw new Error(`AgentDashboard: quantile must be between 0 and 1, got ${String(qv)}`);
  const q = agentQueries(m, qv);
  const ds = props.datasource;
  const p = quantileName(qv);
  const latencyUnit = durationUnit(m.duration.unit);
  const prefix = m.calls.name.replace(/\.calls$/, "");

  const service = new QueryVariable({
    name: "service",
    label: "Service",
    datasource: ds,
    query: q.services,
    multi: true,
    includeAll: true,
    allValue: ".*",
    refresh: "onTimeRangeChange",
    sort: 1,
  });
  const model = new QueryVariable({
    name: "model",
    label: "Model",
    datasource: ds,
    query: q.models,
    multi: true,
    includeAll: true,
    allValue: ".*",
    refresh: "onTimeRangeChange",
    sort: 1,
  });

  const series = (title: string, expr: string, by: string, unit: string, description?: string) =>
    new TimeSeriesPanel({
      title,
      ...(description ? { description } : {}),
      datasource: ds,
      gridPos: { w: 8, h: 8 },
      targets: [new PromQuery({ expr, legendFormat: legend(by) })],
      fieldConfig: { defaults: { unit, ...(unit === "percentunit" ? { min: 0 } : {}) } },
    });

  const { labels } = q;
  const models = new Row({
    title: "Models",
    panels: [
      series("Calls by model", q.model.rate, labels.model, "reqps", `GenAI operations per second, from ${m.calls.prometheus}.`),
      series("Errors by model", q.model.errorRatio, labels.model, "percentunit", `Share of operations that ended with ${labels.status}="${SPAN_STATUS_ERROR}".`),
      series(`Latency ${p} by model`, q.model.latency, labels.model, latencyUnit, `From ${m.duration.prometheus}.`),
    ],
  });
  const tools = new Row({
    title: "Tools",
    panels: [
      series("Tool calls", q.tool.rate, labels.tool, "reqps", `Operations with a ${GENAI_ATTRIBUTES.toolName}, per second.`),
      series("Errors by tool", q.tool.errorRatio, labels.tool, "percentunit"),
      series(`Latency ${p} by tool`, q.tool.latency, labels.tool, latencyUnit),
    ],
  });
  const errors = new Row({
    title: "Errors",
    panels: [
      new TimeSeriesPanel({
        title: "Errors by type",
        description: `Failed operations per second by ${GENAI_ATTRIBUTES.errorType}.`,
        datasource: ds,
        gridPos: { w: 24, h: 8 },
        targets: [new PromQuery({ expr: q.errorsByType, legendFormat: legend(labels.errorType) })],
        fieldConfig: { defaults: { unit: "reqps" } },
      }),
    ],
  });
  // One instant query at the end of the range: `increase(...[$__range])`
  // is the total over the whole range, so evaluating it at every step of a
  // range query would only repeat that work for points the stat throws away.
  const tokenStat = (title: string, expr: string) =>
    new StatPanel({
      title,
      description: "Over the dashboard's time range.",
      datasource: ds,
      gridPos: { w: 4, h: 8 },
      targets: [new PromQuery({ expr, legendFormat: title, instant: true, range: false })],
      options: { graphMode: "none", colorMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
      fieldConfig: { defaults: { unit: "short", decimals: 0 } },
    });
  const tokenRate = (title: string, expr: string, source: string) =>
    new TimeSeriesPanel({
      title,
      description: `Tokens per second by model, from ${source}.`,
      datasource: ds,
      gridPos: { w: 8, h: 8 },
      targets: [new PromQuery({ expr, legendFormat: legend(labels.tokenModel) })],
      fieldConfig: { defaults: { unit: "short" }, overrides: [] },
      options: { tooltip: { mode: "multi" } },
    });
  const tokens = new Row({
    title: "Tokens",
    panels: [
      tokenRate("Input tokens by model", q.tokens.inputRate, m.inputTokens.prometheus),
      tokenRate("Output tokens by model", q.tokens.outputRate, m.outputTokens.prometheus),
      tokenStat("Input tokens", q.tokens.inputTotal),
      tokenStat("Output tokens", q.tokens.outputTotal),
    ],
  });

  const dashboard = new Dashboard({
    ...dashboardProps(props, {
      title: "Agents: models, tools and tokens",
      uid: slugUid(`${prefix}-agents`),
      description: `Calls, errors and latency per model and tool, and token usage per model, from the ${prefix} GenAI metrics.`,
      tags: ["genai", "agents"],
    }),
    variables: [service, model],
    panels: [models, tools, errors, tokens],
  });
  return { dashboard };
}, "AgentDashboard");
