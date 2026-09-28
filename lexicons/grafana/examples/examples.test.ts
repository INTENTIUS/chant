import { describe, expect, test } from "vitest";
import { join } from "path";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { load } from "js-yaml";
import { grafanaSerializer, validateGrafanaOutput, type GrafanaIndex, type ProvisionedDatasource } from "@intentius/chant-lexicon-grafana";
import { otelSerializer, spanMetricsNames } from "@intentius/chant-lexicon-otel";
import { prometheusSerializer, sloMetrics } from "@intentius/chant-lexicon-prometheus";
import { spans, genai } from "./dashboards-from-declarations/src/components";
import { checkout } from "./dashboards-from-declarations/src/slo";

describeAllExamples(
  {
    lexicon: "grafana",
    serializer: grafanaSerializer,
    outputKey: "grafana",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const index = JSON.parse(output) as GrafanaIndex;
        expect(index.dashboards).toEqual([
          { uid: "service-overview", title: "Service overview", folder: "Services", file: "dashboards/Services/service-overview.json" },
        ]);
        expect(index.datasources.map((d) => `${d.name}:${d.type}:${d.uid}`)).toEqual(["Loki:loki:loki", "Prometheus:prometheus:prometheus", "Tempo:tempo:tempo"]);
        expect(index.files).toEqual([
          "dashboards/Services/service-overview.json",
          "provisioning/dashboards/chant.yaml",
          "provisioning/datasources/chant.yaml",
        ]);
      },
    },
    // Built with the otel and prometheus serializers too, below.
    "dashboards-from-declarations": { skipBuild: true },
  },
);

describe("the dashboards-from-declarations example", () => {
  const srcDir = join(import.meta.dirname, "dashboards-from-declarations", "src");

  test("builds the collector, the SLO rules and three dashboards from one build root, all clean", async () => {
    const result = await build(srcDir, [otelSerializer, prometheusSerializer, grafanaSerializer]);
    expect(result.errors).toHaveLength(0);
    const grafana = result.outputs.get("grafana") as SerializerResult;
    const index = JSON.parse(grafana.primary) as GrafanaIndex;
    expect(index.dashboards.map((d) => d.uid).sort()).toEqual(["agents-agents", "red-shop", "slo-checkout"]);
    expect(index.datasources.map((d) => d.type)).toEqual(["prometheus", "tempo"]);

    const dashboards = index.dashboards.map((d) => ({ source: d.file, json: JSON.parse(grafana.files![d.file]) as Record<string, unknown> }));
    const { datasources } = load(grafana.files!["provisioning/datasources/chant.yaml"]) as { datasources: ProvisionedDatasource[] };
    expect(validateGrafanaOutput({ dashboards, datasources })).toEqual([]);

    // Each dashboard queries the names its source declaration produces.
    const dashboard = (uid: string) => JSON.stringify(dashboards.find((d) => d.json.uid === uid)!.json);
    const red = spanMetricsNames(spans);
    expect(dashboard("red-shop")).toContain(red.calls.prometheus);
    expect(dashboard("red-shop")).toContain(`${red.duration!.prometheus}_bucket`);
    for (const b of sloMetrics(checkout).burnRates) expect(dashboard("slo-checkout")).toContain(b.longRecord);
    expect(dashboard("agents-agents")).toContain(genai.metrics.calls.prometheus);
    expect(dashboard("agents-agents")).toContain(genai.metrics.inputTokens.prometheus);

    // The SLO's rules and the collector read the same connector.
    const output = (key: string) => {
      const out = result.outputs.get(key) as SerializerResult | string;
      return typeof out === "string" ? out : out.primary;
    };
    expect(output("prometheus")).toContain(red.calls.prometheus);
    expect(output("otel")).toContain("namespace: shop");
  });
});
