/**
 * `AgentDashboard`: latency and errors per model and per tool, and token
 * usage per model, from the otel lexicon's GenAI preset.
 *
 * Metric names come from `genAiMetrics()` (or the `metrics` of
 * `genAiComponents()`), and label names from the preset's GenAI attribute
 * keys, so a preset with another `namespace` moves every query here.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { GENAI_ATTRIBUTES, type GenAiMetric, type GenAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { prometheusLabel, SPAN_STATUS_ERROR } from "@intentius/chant-lexicon-otel/metric-names";
import { Dashboard, type DashboardEntity } from "../dashboard";
import { Row, StatPanel, TimeSeriesPanel } from "../panels";
import { PromQuery } from "../query";
import { QueryVariable } from "../variables";
import { slugUid } from "../util";
import {
  dashboardProps,
  durationUnit,
  legend,
  quantile,
  quantileName,
  requireDatasource,
  selector,
  sumRate,
  type DashboardOptions,
  type Matcher,
} from "./shared";

export interface AgentDashboardProps extends DashboardOptions {
  /** The preset's metrics: `genAiMetrics(options)` with the options the collector was built with, or `genAiComponents(options)`. */
  genAi: GenAiMetrics | { metrics: GenAiMetrics };
  /** The latency quantile per model and per tool (default 0.95). */
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
  const ratio = (matchers: Matcher[], by: string[]) =>
    `${sumRate(selector(calls, [...matchers, err]), by)}\n/\n${sumRate(selector(calls, matchers), by)}`;
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
 * ```
 */
export const AgentDashboard = Composite<AgentDashboardProps, AgentDashboardMembers>((props) => {
  requireDatasource("AgentDashboard", props.datasource);
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
  const tokenStat = (title: string, expr: string) =>
    new StatPanel({
      title,
      description: "Over the dashboard's time range.",
      datasource: ds,
      gridPos: { w: 4, h: 8 },
      targets: [new PromQuery({ expr, legendFormat: title })],
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
