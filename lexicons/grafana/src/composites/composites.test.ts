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
import { checkPromql } from "@intentius/chant-lexicon-prometheus/promql";
import { Datasource } from "../datasource";
import { buildGrafana, type DashboardJson } from "../build";
import { validateGrafanaOutput } from "../validate-output";
import { validateDashboardSchema } from "../schema-validate";
import { AgentDashboard, RedDashboard, SloDashboard } from "./index";

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
  return expr.replaceAll("$__rate_interval", "5m").replaceAll("$__range", "1h");
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
    expect(panelByTitle(json, "Rate").targets).toMatchObject([
      { expr: 'sum by (service_name) (rate(traces_span_metrics_calls_total{service_name=~"$service"}[$__rate_interval]))' },
    ]);
    expect((panelByTitle(json, "Errors").targets as Json[])[0].expr).toContain('status_code="STATUS_CODE_ERROR"');
    expect((panelByTitle(json, "Duration p95").targets as Json[])[0].expr).toBe(
      'histogram_quantile(0.95, sum by (le, service_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name=~"$service"}[$__rate_interval])))',
    );
    expect((panelByTitle(json, "Duration p95").fieldConfig as { defaults: Json }).defaults.unit).toBe("ms");
    const templating = json.templating as unknown as { list: Json[] };
    expect(templating.list.map((v) => [v.name, v.query])).toEqual([["service", "label_values(traces_span_metrics_calls_total, service_name)"]]);
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
    expect((panelByTitle(json, "Errors by model").targets as Json[])[0].expr).toBe(
      'sum by (gen_ai_request_model) (rate(genai_calls_total{service_name=~"$service", gen_ai_request_model=~"$model", status_code="STATUS_CODE_ERROR"}[$__rate_interval]))\n/\n' +
        'sum by (gen_ai_request_model) (rate(genai_calls_total{service_name=~"$service", gen_ai_request_model=~"$model"}[$__rate_interval]))',
    );
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

  test("refuses metrics without the dimensions it breaks down by", () => {
    const m = genAiMetrics();
    const stripped = { ...m, calls: { ...m.calls, dimensions: m.calls.dimensions.filter((d) => d !== "gen_ai.tool.name") } };
    expect(() => AgentDashboard({ genAi: stripped, datasource: prometheus })).toThrow(/gen_ai\.tool\.name/);
    expect(() => AgentDashboard({ genAi: {} as never, datasource: prometheus })).toThrow(/genAiMetrics/);
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
