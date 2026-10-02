import { describe, expect, test } from "vitest";
import { PrometheusExporter, SpanMetricsConnector } from "./components";
import { genAiComponents, genAiMetrics } from "./genai";
import { prometheusLabel, prometheusMetricName, spanMetricsNames } from "./metric-names";

describe("spanMetricsNames", () => {
  test("defaults: the traces.span.metrics namespace and a millisecond histogram", () => {
    const n = spanMetricsNames(new SpanMetricsConnector({}));
    expect(n.namespace).toBe("traces.span.metrics");
    expect(n.calls).toEqual({
      name: "traces.span.metrics.calls",
      prometheus: "traces_span_metrics_calls_total",
      type: "sum",
      dimensions: ["service.name", "span.name", "span.kind", "status.code"],
    });
    expect(n.duration?.prometheus).toBe("traces_span_metrics_duration_milliseconds");
    expect(n.duration?.unit).toBe("ms");
    expect(n.events).toBeUndefined();
    expect(n.labels).toEqual({ service: "service_name", spanName: "span_name", spanKind: "span_kind", statusCode: "status_code" });
    expect(n.errorStatus).toBe("STATUS_CODE_ERROR");
  });

  test("namespace, unit and dimensions come from the declaration", () => {
    const connector = new SpanMetricsConnector({
      namespace: "shop.spans",
      dimensions: [{ name: "http.route" }],
      calls_dimensions: [{ name: "peer.service" }],
      exclude_dimensions: ["span.kind"],
      histogram: { unit: "s", dimensions: [{ name: "http.method" }] },
      events: { enabled: true, dimensions: [{ name: "exception.type" }] },
    });
    const n = spanMetricsNames(connector);
    expect(n.calls.prometheus).toBe("shop_spans_calls_total");
    expect(n.calls.dimensions).toEqual(["service.name", "span.name", "status.code", "http.route", "peer.service"]);
    expect(n.duration?.prometheus).toBe("shop_spans_duration_seconds");
    expect(n.duration?.dimensions).toEqual(["service.name", "span.name", "status.code", "http.route", "http.method"]);
    expect(n.events?.prometheus).toBe("shop_spans_events_total");
    expect(n.labels.spanKind).toBeUndefined();
  });

  test("an empty namespace means no prefix; a disabled histogram means no duration", () => {
    const n = spanMetricsNames({ namespace: "", histogram: { disable: true } });
    expect(n.calls.prometheus).toBe("calls_total");
    expect(n.duration).toBeUndefined();
  });

  test("the exporter's namespace and suffix setting", () => {
    const connector = new SpanMetricsConnector({ namespace: "spans" });
    const exporter = new PrometheusExporter({ endpoint: "0.0.0.0:8889", namespace: "otel" });
    expect(spanMetricsNames(connector, exporter).calls.prometheus).toBe("otel_spans_calls_total");
    expect(spanMetricsNames(connector, { add_metric_suffixes: false }).duration?.prometheus).toBe("spans_duration");
  });

  test("only a spanmetrics connector", () => {
    expect(() => spanMetricsNames(new PrometheusExporter({ endpoint: "0.0.0.0:8889" }) as never)).toThrow(/spanmetrics/);
  });

  test("agrees with genAiMetrics for the preset's own connector", () => {
    for (const namespace of [undefined, "agents"]) {
      const parts = genAiComponents({ namespace });
      const n = spanMetricsNames(parts.spanMetrics);
      const g = genAiMetrics({ namespace });
      expect(n.calls.prometheus).toBe(g.calls.prometheus);
      expect(n.duration?.prometheus).toBe(g.duration.prometheus);
      expect(n.calls.dimensions).toEqual(g.calls.dimensions);
    }
  });
});

describe("prometheus naming", () => {
  test("labels", () => {
    expect(prometheusLabel("gen_ai.request.model")).toBe("gen_ai_request_model");
    expect(prometheusLabel("0day")).toBe("key_0day");
  });
  test("suffixes are not doubled, and brace units add nothing", () => {
    expect(prometheusMetricName("requests_total", "sum")).toBe("requests_total");
    expect(prometheusMetricName("latency.seconds", "histogram", "s")).toBe("latency_seconds");
    expect(prometheusMetricName("calls", "sum", "{call}")).toBe("calls_total");
  });
});
