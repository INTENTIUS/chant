/**
 * The dashboard composites build from the declarations they read: renaming a
 * metric or namespace at the source moves it in every panel query, the
 * rendered dashboards pass every GRAF check (GRAF107 is the pinned schema),
 * and every panel's PromQL parses.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { PrometheusExporter, SpanMetricsConnector } from "@intentius/chant-lexicon-otel/components/index";
import { genAiComponents, genAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { spanMetricsNames } from "@intentius/chant-lexicon-otel/metric-names";
import { Slo, sloMetrics, type SloProps } from "@intentius/chant-lexicon-prometheus/composites/slo";
import { GenAiRules, genAiRuleMetrics, type GenAiPrice } from "@intentius/chant-lexicon-prometheus/composites/genai";
import { checkPromql } from "@intentius/chant-lexicon-prometheus/promql";
import { Datasource } from "../datasource";
import { buildGrafana, type DashboardJson } from "../build";
import { validateGrafanaOutput } from "../validate-output";
import { validateDashboardSchema } from "../schema-validate";
import { AgentDashboard, agentRuleQueries, RedDashboard, redQueries, SloDashboard } from "./index";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });

type Json = Record<string, unknown>;

/** Build the dashboard with the datasource beside it, as one build root. */
function built(dashboard: Declarable, ...more: Declarable[]) {
  const out = buildGrafana([prometheus, dashboard, ...more]);
  expect(out.dashboards).toHaveLength(1);
  return { out, json: out.dashboards[0].json };
}

/** Every panel, rows' children included. */
function panels(json: DashboardJson): Json[] {
  const all: Json[] = [];
  for (const p of json.panels as unknown as Json[]) {
    all.push(p);
    for (const c of (p.panels as Json[] | undefined) ?? []) all.push(c);
  }
  return all.filter((p) => p.type !== "row");
}

/** Every PromQL expression in the dashboard's panels. */
function exprs(json: DashboardJson): string[] {
  return panels(json).flatMap((p) => ((p.targets as Json[] | undefined) ?? []).map((t) => t.expr as string));
}

/** Grafana's built-in variables as a parser would see them once Grafana fills them in. */
function asPromql(expr: string): string {
  return expr.replaceAll("$__rate_interval", "5m").replaceAll("$__range_s", "3600").replaceAll("$__range", "1h");
}

function expectClean(json: DashboardJson, out: ReturnType<typeof buildGrafana>) {
  expect(validateDashboardSchema(json as unknown as Json)).toEqual([]);
  const issues = validateGrafanaOutput({
    dashboards: out.dashboards.map((d) => ({ source: d.file, json: d.json as unknown as Json })),
    datasources: out.datasources,
  });
  expect(issues).toEqual([]);
  const all = exprs(json);
  expect(all.length).toBeGreaterThan(0);
  for (const e of all) {
    const r = checkPromql(asPromql(e));
    expect(r, e).toEqual({ ok: true });
  }
}

function panelByTitle(json: DashboardJson, title: string): Json {
  const p = panels(json).find((x) => x.title === title);
  if (!p) throw new Error(`no panel "${title}" in ${panels(json).map((x) => x.title).join(", ")}`);
  return p;
}

// ── RED ─────────────────────────────────────────────────────────

describe("RedDashboard", () => {
  test("rate, errors and p50/p95/p99 duration per service, from the connector's names", () => {
    const spans = new SpanMetricsConnector({});
    const { json, out } = built(RedDashboard({ spanMetrics: spans, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(json.uid).toBe("red-traces-span-metrics");
    expect(panels(json).map((p) => p.title)).toEqual(["Rate", "Errors", "Duration p50", "Duration p95", "Duration p99"]);
    const calls = 'traces_span_metrics_calls_total{service_name=~"$service", span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"}';
    const errors = 'traces_span_metrics_calls_total{service_name=~"$service", span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER", status_code="STATUS_CODE_ERROR"}';
    expect(panelByTitle(json, "Rate").targets).toMatchObject([{ expr: `sum by (service_name) (rate(${calls}[$__rate_interval]))` }]);
    expect(panelByTitle(json, "Rate").description).toBe("Server and consumer spans per second by service, from traces_span_metrics_calls_total.");
    expect((panelByTitle(json, "Errors").targets as Json[])[0].expr).toBe(
      "(\n" +
        `sum by (service_name) (rate(${errors}[$__rate_interval]))\n` +
        "or\n" +
        `sum by (service_name) (rate(${calls}[$__rate_interval])) * 0\n` +
        ")\n/\n" +
        `sum by (service_name) (rate(${calls}[$__rate_interval]))`,
    );
    expect((panelByTitle(json, "Duration p95").targets as Json[])[0].expr).toBe(
      'histogram_quantile(0.95, sum by (le, service_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name=~"$service", span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"}[$__rate_interval])))',
    );
    expect((panelByTitle(json, "Duration p95").fieldConfig as { defaults: Json }).defaults.unit).toBe("ms");
    const templating = json.templating as unknown as { list: Json[] };
    expect(templating.list.map((v) => [v.name, v.query])).toEqual([
      ["service", 'label_values(traces_span_metrics_calls_total{span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"}, service_name)'],
    ]);
  });

  test("spanKinds picks the kinds counted; [] counts every kind", () => {
    const names = spanMetricsNames(new SpanMetricsConnector({ namespace: "shop" }));
    const all = redQueries(names, [0.5], "$service", []);
    expect(all.rate).toBe('sum by (service_name) (rate(shop_calls_total{service_name=~"$service"}[$__rate_interval]))');
    expect(all.services).toBe("label_values(shop_calls_total, service_name)");

    const client = redQueries(names, [0.5], "checkout", ["SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CLIENT"]);
    expect(client.rate).toBe(
      'sum by (service_name) (rate(shop_calls_total{service_name=~"checkout", span_kind=~"SPAN_KIND_CLIENT|SPAN_KIND_PRODUCER"}[$__rate_interval]))',
    );
    for (const e of [client.rate, client.errorRatio, ...client.duration.map((d) => d.expr)]) {
      expect(checkPromql(asPromql(e)), e).toEqual({ ok: true });
    }

    const { json, out } = built(
      RedDashboard({ spanMetrics: new SpanMetricsConnector({ namespace: "shop" }), spanKinds: ["SPAN_KIND_SERVER"], datasource: prometheus }).dashboard,
    );
    expectClean(json, out);
    for (const e of exprs(json)) expect(e).toContain('span_kind=~"SPAN_KIND_SERVER"');
    expect(panelByTitle(json, "Errors").description).toBe('Share of server spans with status_code="STATUS_CODE_ERROR", by service.');

    const every = built(RedDashboard({ spanMetrics: new SpanMetricsConnector({ namespace: "shop" }), spanKinds: [], datasource: prometheus }).dashboard);
    for (const e of exprs(every.json)) expect(e).not.toContain("span_kind");
    expect(panelByTitle(every.json, "Rate").description).toBe("Spans per second by service, from shop_calls_total.");
  });

  test("a connector that excludes span.kind gets no kind filter by default, and naming kinds for it is an error", () => {
    const connector = new SpanMetricsConnector({ exclude_dimensions: ["span.kind"] });
    const { json, out } = built(RedDashboard({ spanMetrics: connector, datasource: prometheus }).dashboard);
    expectClean(json, out);
    for (const e of exprs(json)) expect(e).not.toContain("span_kind");
    expect(() => RedDashboard({ spanMetrics: connector, spanKinds: ["SPAN_KIND_SERVER"], datasource: prometheus })).toThrow(/excludes span\.kind/);
    expect(() => RedDashboard({ spanMetrics: connector, spanKinds: [], datasource: prometheus })).not.toThrow();
    expect(() =>
      RedDashboard({ spanMetrics: new SpanMetricsConnector({}), spanKinds: ["SERVER" as never], datasource: prometheus }),
    ).toThrow(/unknown span kind "SERVER"/);
  });

  test("renaming the connector's namespace moves every query; its histogram unit moves the duration metric", () => {
    const before = built(RedDashboard({ spanMetrics: new SpanMetricsConnector({ namespace: "shop" }), datasource: prometheus }).dashboard).json;
    const after = built(
      RedDashboard({ spanMetrics: new SpanMetricsConnector({ namespace: "store", histogram: { unit: "s" } }), datasource: prometheus }).dashboard,
    );
    expectClean(after.json, after.out);
    for (const e of exprs(before)) expect(e).toMatch(/shop_(calls_total|duration_milliseconds_bucket)/);
    for (const e of exprs(after.json)) {
      expect(e).not.toContain("shop_");
      expect(e).toMatch(/store_(calls_total|duration_seconds_bucket)/);
    }
    expect((panelByTitle(after.json, "Duration p99").fieldConfig as { defaults: Json }).defaults.unit).toBe("s");
    expect(after.json.uid).toBe("red-store");
  });

  test("the exporter's namespace, a names object, custom quantiles, and no histogram", () => {
    const spans = new SpanMetricsConnector({ namespace: "spans", histogram: { disable: true } });
    const exporter = new PrometheusExporter({ endpoint: "0.0.0.0:8889", namespace: "otel" });
    const { json, out } = built(RedDashboard({ spanMetrics: spans, exporter, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(panels(json).map((p) => p.title)).toEqual(["Rate", "Errors"]);
    for (const e of exprs(json)) expect(e).toContain("otel_spans_calls_total");

    const names = spanMetricsNames(new SpanMetricsConnector({ namespace: "x" }));
    const q = built(RedDashboard({ spanMetrics: names, quantiles: [0.9], datasource: prometheus, uid: "mine" }).dashboard).json;
    expect(panels(q).map((p) => p.title)).toEqual(["Rate", "Errors", "Duration p90"]);
    expect(q.uid).toBe("mine");
  });

  test("a { type, uid } ref to a Prometheus declared in another build root", () => {
    const ref = { type: "prometheus" as const, uid: "shared-prom" };
    const out = buildGrafana([RedDashboard({ spanMetrics: new SpanMetricsConnector({}), datasource: ref }).dashboard]);
    const json = out.dashboards[0].json;
    expect(validateDashboardSchema(json as unknown as Json)).toEqual([]);
    expect(panels(json).every((p) => (p.datasource as Json).uid === "shared-prom")).toBe(true);
  });

  test("refuses what it can't build", () => {
    const spans = new SpanMetricsConnector({});
    expect(() => RedDashboard({ spanMetrics: spans, datasource: undefined as never })).toThrow(/datasource is required/);
    const tempo = new Datasource({ name: "Tempo", type: "tempo" });
    expect(() => RedDashboard({ spanMetrics: spans, datasource: tempo as never })).toThrow(/Prometheus datasource/);
    expect(() =>
      RedDashboard({ spanMetrics: new SpanMetricsConnector({ exclude_dimensions: ["service.name"] }), datasource: prometheus }),
    ).toThrow(/service\.name/);
    expect(() => RedDashboard({ spanMetrics: spans, quantiles: [95], datasource: prometheus })).toThrow(/between 0 and 1/);
  });
});

// ── SLO ─────────────────────────────────────────────────────────

const sloProps = (over: Partial<SloProps> = {}): SloProps => ({
  name: "checkout",
  objective: 0.999,
  window: "30d",
  sli: {
    errors: 'sum(rate(traces_span_metrics_calls_total{span_name="checkout",status_code="STATUS_CODE_ERROR"}[{{window}}]))',
    total: 'sum(rate(traces_span_metrics_calls_total{span_name="checkout"}[{{window}}]))',
  },
  ...over,
});

describe("SloDashboard", () => {
  test("SLI, budget left, alerts firing, and one burn-rate panel per alert window with its threshold", () => {
    const slo = Slo(sloProps());
    const m = sloMetrics(slo);
    const { json, out } = built(SloDashboard({ slo, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(json.uid).toBe("slo-checkout");
    expect(json.title).toBe("SLO: checkout");
    expect((panelByTitle(json, "SLI over 30d").targets as Json[])[0].expr).toBe('1 - slo:sli_error:ratio_rate30d{slo="checkout"}');
    expect((panelByTitle(json, "Error budget remaining").targets as Json[])[0].expr).toBe('slo:error_budget:remaining{slo="checkout"}');
    expect((panelByTitle(json, "Burn-rate alerts firing").targets as Json[])[0].expr).toBe(
      'sum(ALERTS{alertname="ErrorBudgetBurn", slo="checkout", alertstate="firing"}) or vector(0)',
    );

    const burn = panels(json).filter((p) => String(p.title).startsWith("Burn rate "));
    expect(burn.map((p) => p.title)).toEqual([
      "Burn rate 1h / 5m (page)",
      "Burn rate 6h / 30m (page)",
      "Burn rate 1d / 2h (ticket)",
      "Burn rate 3d / 6h (ticket)",
    ]);
    // The Workbook's factors on a 30-day window, drawn where the alert fires.
    expect(m.burnRates.map((b) => b.factor)).toEqual([14.4, 6, 3, 1]);
    burn.forEach((p, i) => {
      const b = m.burnRates[i];
      const defaults = (p.fieldConfig as { defaults: Json }).defaults as { thresholds: { steps: Json[] }; custom: Json };
      expect(defaults.thresholds.steps).toEqual([
        { value: null, color: "green" },
        { value: b.factor, color: "red" },
      ]);
      expect(defaults.custom.thresholdsStyle).toEqual({ mode: "dashed" });
      expect((p.targets as Json[]).map((t) => t.expr)).toEqual([
        `slo:sli_error:ratio_rate${b.long}{slo="checkout"} / 0.001`,
        `slo:sli_error:ratio_rate${b.short}{slo="checkout"} / 0.001`,
      ]);
    });

    // The SLI's threshold is the objective.
    const sliSteps = ((panelByTitle(json, "SLI over 30d").fieldConfig as { defaults: Json }).defaults as { thresholds: { steps: Json[] } }).thresholds.steps;
    expect(sliSteps[1]).toEqual({ value: 0.999, color: "green" });
  });

  test("renaming the SLO, changing its window, objective or burn rates moves the panels and thresholds", () => {
    const slo = Slo(
      sloProps({
        name: "order-ack",
        objective: 0.995,
        window: "28d",
        alerting: { page: { burnRates: [{ long: "2h", short: "10m", factor: 10 }] }, ticket: false, alertName: "OrderAckBurn" },
      }),
    );
    const { json, out } = built(SloDashboard({ slo, datasource: prometheus }).dashboard);
    expectClean(json, out);
    for (const e of exprs(json)) {
      expect(e).not.toContain('slo="checkout"');
      expect(e).toContain('"order-ack"');
    }
    expect(json.uid).toBe("slo-order-ack");
    expect(panelByTitle(json, "SLI over 28d")).toBeDefined();
    expect((panelByTitle(json, "Burn-rate alerts firing").targets as Json[])[0].expr).toContain('alertname="OrderAckBurn"');
    const burn = panels(json).filter((p) => String(p.title).startsWith("Burn rate "));
    expect(burn.map((p) => p.title)).toEqual(["Burn rate 2h / 10m (page)"]);
    expect((burn[0].targets as Json[]).map((t) => t.expr)).toEqual([
      'slo:sli_error:ratio_rate2h{slo="order-ack"} / 0.005',
      'slo:sli_error:ratio_rate10m{slo="order-ack"} / 0.005',
    ]);
    const steps = ((burn[0].fieldConfig as { defaults: Json }).defaults as { thresholds: { steps: Json[] } }).thresholds.steps;
    expect(steps[1]).toEqual({ value: 10, color: "red" });
  });

  test("reads the rule group, or sloMetrics() output, the same as the Slo", () => {
    const slo = Slo(sloProps());
    const a = built(SloDashboard({ slo, datasource: prometheus }).dashboard).json;
    const b = built(SloDashboard({ slo: slo.rules, datasource: prometheus }).dashboard).json;
    const c = built(SloDashboard({ slo: sloMetrics(slo), datasource: prometheus }).dashboard).json;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("no burn-rate row when alerting is off", () => {
    const slo = Slo(sloProps({ alerting: { page: false, ticket: false } }));
    const { json, out } = built(SloDashboard({ slo, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(panels(json).some((p) => String(p.title).startsWith("Burn rate "))).toBe(false);
  });
});

// ── Agents ──────────────────────────────────────────────────────

describe("AgentDashboard", () => {
  test("latency and errors per model and tool, errors by type, tokens per model", () => {
    const { json, out } = built(AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(json.uid).toBe("genai-agents");
    expect(panels(json).map((p) => p.title)).toEqual([
      "Calls by model",
      "Errors by model",
      "Latency p95 by model",
      "Tool calls",
      "Errors by tool",
      "Latency p95 by tool",
      "Errors by type",
      "Input tokens by model",
      "Output tokens by model",
      "Input tokens",
      "Output tokens",
    ]);
    const calls = 'genai_calls_total{service_name=~"$service", gen_ai_request_model=~"$model"}';
    const errors = 'genai_calls_total{service_name=~"$service", gen_ai_request_model=~"$model", status_code="STATUS_CODE_ERROR"}';
    expect((panelByTitle(json, "Errors by model").targets as Json[])[0].expr).toBe(
      "(\n" +
        `sum by (gen_ai_request_model) (rate(${errors}[$__rate_interval]))\n` +
        "or\n" +
        `sum by (gen_ai_request_model) (rate(${calls}[$__rate_interval])) * 0\n` +
        ")\n/\n" +
        `sum by (gen_ai_request_model) (rate(${calls}[$__rate_interval]))`,
    );
    expect((panelByTitle(json, "Errors by tool").targets as Json[])[0].expr).toMatch(/^\(\nsum by \(gen_ai_tool_name\) .*\nor\n.* \* 0\n\)\n\/\n/s);
    // The token totals are one instant query each, not a range query of full-range increases.
    for (const [title, metric] of [["Input tokens", "genai_tokens_input_total"], ["Output tokens", "genai_tokens_output_total"]]) {
      expect(panelByTitle(json, title).targets).toMatchObject([
        { expr: `sum(increase(${metric}{gen_ai_request_model=~"$model"}[$__range]))`, instant: true, range: false },
      ]);
    }
    for (const title of ["Input tokens by model", "Errors by model"]) {
      expect((panelByTitle(json, title).targets as Json[])[0].instant).toBeUndefined();
    }
    expect((panelByTitle(json, "Latency p95 by tool").targets as Json[])[0].expr).toBe(
      'histogram_quantile(0.95, sum by (le, gen_ai_tool_name) (rate(genai_duration_seconds_bucket{service_name=~"$service", gen_ai_request_model=~"$model", gen_ai_tool_name!=""}[$__rate_interval])))',
    );
    expect((panelByTitle(json, "Output tokens by model").targets as Json[])[0].expr).toBe(
      'sum by (gen_ai_request_model) (rate(genai_tokens_output_total{gen_ai_request_model=~"$model"}[$__rate_interval]))',
    );
    expect((panelByTitle(json, "Errors by type").targets as Json[])[0].expr).toContain("sum by (error_type)");
    const templating = json.templating as unknown as { list: Json[] };
    expect(templating.list.map((v) => v.name)).toEqual(["service", "model"]);
  });

  test("a preset with another namespace moves every query", () => {
    const m = genAiMetrics({ namespace: "agents" });
    const { json, out } = built(AgentDashboard({ genAi: m, datasource: prometheus }).dashboard);
    expectClean(json, out);
    const names = [m.calls.prometheus, `${m.duration.prometheus}_bucket`, m.inputTokens.prometheus, m.outputTokens.prometheus];
    for (const e of exprs(json)) {
      expect(e).not.toContain("genai_");
      expect(names.some((n) => e.includes(n))).toBe(true);
    }
    expect(json.uid).toBe("agents-agents");
  });

  test("reads genAiComponents() the same as genAiMetrics()", () => {
    const a = built(AgentDashboard({ genAi: genAiMetrics({ namespace: "ai" }), datasource: prometheus }).dashboard).json;
    const b = built(AgentDashboard({ genAi: genAiComponents({ namespace: "ai" }), datasource: prometheus }).dashboard).json;
    expect(b).toEqual(a);
  });

  test("builds against a preset that also emits the conventions' client metrics", () => {
    for (const source of ["derive", "passthrough"] as const) {
      const m = genAiMetrics({ clientMetrics: source, providerDimensions: true });
      expect(m.client?.operationDuration.prometheus).toBe("gen_ai_client_operation_duration_seconds");
      expect(m.client?.tokenUsage.prometheus).toBe("gen_ai_client_token_usage");
      const { json, out } = built(AgentDashboard({ genAi: m, datasource: prometheus }).dashboard);
      expectClean(json, out);
      const c = built(AgentDashboard({ genAi: genAiComponents({ clientMetrics: source, providerDimensions: true }), datasource: prometheus }).dashboard);
      expect(c.json).toEqual(json);
    }
  });

  test("refuses metrics without the dimensions it breaks down by", () => {
    const m = genAiMetrics();
    const stripped = { ...m, calls: { ...m.calls, dimensions: m.calls.dimensions.filter((d) => d !== "gen_ai.tool.name") } };
    expect(() => AgentDashboard({ genAi: stripped, datasource: prometheus })).toThrow(/gen_ai\.tool\.name/);
    expect(() => AgentDashboard({ genAi: {} as never, datasource: prometheus })).toThrow(/genAiMetrics/);
  });
});

describe("AgentDashboard from GenAiRules", () => {
  const prices: GenAiPrice[] = [
    { provider: "anthropic", model: "big", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com/a", asOf: "2026-09-29" },
    { provider: "openai", model: "small", inputPerMTok: 1, outputPerMTok: 4, currency: "USD", source: "https://example.com/o", asOf: "2026-09-01" },
    { provider: "mistral", model: "eu", inputPerMTok: 2, outputPerMTok: 6, currency: "EUR", source: "https://example.com/m" },
  ];
  const titles = (json: DashboardJson) => panels(json).map((p) => p.title);
  const expr = (json: DashboardJson, title: string) => (panelByTitle(json, title).targets as Json[])[0].expr as string;
  const varNames = (json: DashboardJson) => (json.templating as unknown as { list: Json[] }).list.map((v) => v.name);

  test("the conventions' client metrics: provider, tools, cost per currency and alerts", () => {
    const rules = GenAiRules({
      genAi: genAiMetrics({ clientMetrics: "derive" }),
      prices,
      groupBy: ["service_name"],
      alerts: { errorRatio: true, budgets: [{ amount: 50, currency: "USD", per: "day" }] },
    });
    const m = genAiRuleMetrics(rules);
    expect(m.source).toBe("client");
    const { json, out } = built(AgentDashboard({ rules, datasource: prometheus }).dashboard, rules.rules);
    expectClean(json, out);
    expect(json.uid).toBe("genai-agents");
    expect(json.title).toBe("Agents: models, tools, tokens and cost");
    expect(varNames(json)).toEqual(["service", "provider", "model"]);
    expect(titles(json)).toEqual([
      "Requests by model",
      "Errors by model",
      "Latency p95 by model",
      "Requests by provider",
      "Errors by provider",
      "Tokens by provider",
      "Tool calls",
      "Errors by tool",
      "Latency p95 by tool",
      "Errors by type",
      "GenAI alerts firing",
      "Input tokens by model",
      "Output tokens by model",
      "Input tokens",
      "Output tokens",
      "Spend per hour in USD",
      "Spend in USD, prices as of 2026-09-01 to 2026-09-29",
      "Spend per hour in EUR",
      "Spend in EUR",
    ]);
    const scope = 'service_name=~"$service", gen_ai_provider_name=~"$provider", gen_ai_request_model=~"$model"';
    expect(expr(json, "Requests by model")).toBe(
      `sum by (gen_ai_provider_name, gen_ai_request_model, gen_ai_operation_name) (${m.requests}{${scope}})`,
    );
    expect(expr(json, "Latency p95 by model")).toBe(`${m.latency.record}{${scope}, quantile="0.95"}`);
    expect(expr(json, "Errors by provider")).toBe(
      "(\n" +
        `sum by (gen_ai_provider_name) (${m.errors}{${scope}})\n` +
        "or\n" +
        `sum by (gen_ai_provider_name) (${m.requests}{${scope}}) * 0\n` +
        ")\n/\n" +
        `sum by (gen_ai_provider_name) (${m.requests}{${scope}})`,
    );
    expect(expr(json, "Input tokens")).toBe(
      `sum(avg_over_time(${m.tokens}{${scope}, gen_ai_token_type="input"}[$__range])) * $__range_s`,
    );
    // Each currency is its own query; no expression adds two currencies.
    expect(expr(json, "Spend per hour in USD")).toBe(
      `sum by (gen_ai_provider_name, gen_ai_request_model) (${m.cost}{${scope}, currency="USD"}) * 3600`,
    );
    expect(expr(json, "Spend in EUR")).toBe(`sum(avg_over_time(${m.cost}{${scope}, currency="EUR"}[$__range])) * $__range_s`);
    for (const e of exprs(json).filter((x) => x.includes(m.cost!))) expect(e).toMatch(/currency="(USD|EUR)"/);
    expect((panelByTitle(json, "Spend in USD, prices as of 2026-09-01 to 2026-09-29").fieldConfig as { defaults: Json }).defaults.unit).toBe("currencyUSD");
    expect(String(panelByTitle(json, "Spend in EUR").description)).toContain("Models without a price are not counted");
    expect(panelByTitle(json, "Input tokens").targets).toMatchObject([{ instant: true, range: false }]);
    expect(expr(json, "GenAI alerts firing")).toBe(
      'sum(ALERTS{alertname=~"GenAiErrorRatioHigh|GenAiSpendOverBudget", alertstate="firing"}) or vector(0)',
    );
    expect(expr(json, "Latency p95 by tool")).toBe(`${m.tool!.latency.record}{service_name=~"$service", quantile="0.95"}`);
    // Every series the dashboard reads is one the rules record.
    const recorded = new Set([m.requests, m.errors, m.latency.record, m.tokens, m.cost!, m.tool!.calls, m.tool!.errors, m.tool!.latency.record, "ALERTS"]);
    for (const e of exprs(json)) {
      const names = [...e.matchAll(/([A-Za-z_:][A-Za-z0-9_:]*)\{/g)].map((x) => x[1]);
      expect(names.length, e).toBeGreaterThan(0);
      for (const n of names) expect(recorded.has(n), `${n} in ${e}`).toBe(true);
    }
  });

  test("span metrics without provider dimensions or groupBy: no provider or service picker", () => {
    const rules = GenAiRules({ genAi: genAiComponents({ namespace: "agents" }), prices: [prices[0]] });
    const m = genAiRuleMetrics(rules);
    expect(m.source).toBe("spans");
    expect(m.labels.provider).toBeUndefined();
    const { json, out } = built(AgentDashboard({ rules, datasource: prometheus, quantile: 0.99 }).dashboard);
    expectClean(json, out);
    expect(varNames(json)).toEqual(["model"]);
    expect(titles(json)).not.toContain("Requests by provider");
    expect(titles(json)).toContain("Latency p99 by model");
    expect(titles(json)).toContain("Spend in USD, prices as of 2026-09-29");
    expect(String(json.description)).toContain("groupBy service_name or job");
    expect(expr(json, "Requests by model")).toBe(`sum by (gen_ai_request_model, gen_ai_operation_name) (${m.requests}{gen_ai_request_model=~"$model"})`);
    // The cost series carry the price's provider even though the span token sums don't.
    expect(expr(json, "Spend per hour in USD")).toBe(
      `sum by (gen_ai_provider_name, gen_ai_request_model) (${m.cost}{gen_ai_request_model=~"$model", currency="USD"}) * 3600`,
    );
  });

  test("span metrics with provider dimensions: the provider picker leaves the model-only token sums alone", () => {
    const rules = GenAiRules({ genAi: genAiMetrics({ providerDimensions: true }), groupBy: ["job"] });
    const { json, out } = built(AgentDashboard({ rules, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(varNames(json)).toEqual(["service", "provider", "model"]);
    expect(titles(json)).toContain("Requests by provider");
    expect(titles(json)).not.toContain("Tokens by provider");
    expect(expr(json, "Input tokens by model")).not.toContain("$provider");
    expect(expr(json, "Input tokens by model")).toContain('job=~"$service"');
  });

  test("a panel whose series is absent is left out, not shown empty", () => {
    const m = genAiMetrics({ clientMetrics: "passthrough" });
    const noTool = { ...m, calls: { ...m.calls, dimensions: m.calls.dimensions.filter((d) => d !== "gen_ai.tool.name") } };
    const rules = GenAiRules({ genAi: noTool });
    expect(genAiRuleMetrics(rules).tool).toBeUndefined();
    const { json, out } = built(AgentDashboard({ rules, datasource: prometheus }).dashboard);
    expectClean(json, out);
    expect(json.title).toBe("Agents: models, tools and tokens");
    const rows = (json.panels as unknown as Json[]).filter((p) => p.type === "row").map((p) => p.title);
    expect(rows).toEqual(["Models", "Providers", "Errors", "Tokens"]);
    for (const absent of ["Tool calls", "GenAI alerts firing", "Spend per hour in USD"]) expect(titles(json)).not.toContain(absent);
    expect((panelByTitle(json, "Errors by type").gridPos as Json).w).toBe(24);
  });

  test("reads the GenAiRules result, its rule group and genAiRuleMetrics() the same", () => {
    const rules = GenAiRules({ genAi: genAiMetrics({ clientMetrics: "derive" }), prices });
    const a = built(AgentDashboard({ rules, datasource: prometheus }).dashboard).json;
    const b = built(AgentDashboard({ rules: rules.rules, datasource: prometheus }).dashboard).json;
    const c = built(AgentDashboard({ rules: genAiRuleMetrics(rules), datasource: prometheus }).dashboard).json;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("refuses both modes at once, an unrecorded quantile, and something that isn't GenAiRules", () => {
    const rules = GenAiRules({ genAi: genAiMetrics() });
    expect(() => AgentDashboard({ rules, genAi: genAiMetrics(), datasource: prometheus })).toThrow(/genAi or rules, not both/);
    expect(() => AgentDashboard({ rules, quantile: 0.9, datasource: prometheus })).toThrow(/0\.5, 0\.95, 0\.99, not 0\.9/);
    expect(() => AgentDashboard({ rules: {} as never, datasource: prometheus })).toThrow(/GenAiRules/);
    expect(() => agentRuleQueries(genAiRuleMetrics(rules), 0.75)).toThrow(/not 0\.75/);
  });
});

describe("all three in one build root", () => {
  test("distinct uids and a clean build", () => {
    const out = buildGrafana([
      prometheus,
      RedDashboard({ spanMetrics: new SpanMetricsConnector({}), datasource: prometheus }).dashboard,
      SloDashboard({ slo: Slo(sloProps()), datasource: prometheus }).dashboard,
      AgentDashboard({ genAi: genAiMetrics(), datasource: prometheus }).dashboard,
    ]);
    expect(out.dashboards.map((d) => d.uid)).toEqual(["red-traces-span-metrics", "slo-checkout", "genai-agents"]);
    expect(validateGrafanaOutput({ dashboards: out.dashboards.map((d) => ({ json: d.json as unknown as Json })), datasources: out.datasources })).toEqual([]);
  });
});
