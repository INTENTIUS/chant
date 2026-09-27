import { expect } from "vitest";
import { load } from "js-yaml";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { otelSerializer, validateCollectorConfig, collectorTopology, type CollectorConfig } from "@intentius/chant-lexicon-otel";

/** Every example's config must pass the lexicon's own reference checks with nothing to report. */
function clean(output: string): CollectorConfig {
  const config = load(output) as CollectorConfig;
  expect(validateCollectorConfig(config)).toEqual([]);
  return config;
}

describeAllExamples(
  {
    lexicon: "otel",
    serializer: otelSerializer,
    outputKey: "otel",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const config = clean(output);
        expect(Object.keys(config.exporters ?? {}).sort()).toEqual(["debug", "otlp/tempo"]);
        expect(config.service?.pipelines?.traces?.processors).toEqual(["memory_limiter", "batch"]);
        expect(config.service?.extensions).toEqual(["health_check"]);
      },
    },
    "k8s-node-agent": {
      checks: (output) => {
        const config = clean(output);
        expect(Object.keys(config.receivers ?? {}).sort()).toEqual(["filelog", "hostmetrics", "otlp"]);
        expect(config.service?.extensions).toEqual(["health_check", "zpages", "pprof"]);
        const topo = collectorTopology(config);
        expect(topo.exporters.find((e) => e.id === "otlp/gateway")?.signals.sort()).toEqual(["logs", "traces"]);
      },
    },
    "genai-agent": {
      checks: (output) => {
        expect(output.split("\n")[0]).toMatch(/^# chant: semconv gen_ai github\.com\/open-telemetry\/semantic-conventions@v1\.41\.1 /);
        const config = clean(output);
        expect(Object.keys(config.service?.pipelines ?? {})).toEqual(["traces", "traces/genai", "metrics/genai"]);
        expect(config.service?.pipelines?.traces?.processors).toEqual([
          "memory_limiter",
          "transform/genai_content",
          "redaction/genai_content",
          "batch",
        ]);
        expect(config.service?.pipelines?.["metrics/genai"]?.exporters).toEqual(["prometheus"]);
        const topo = collectorTopology(config);
        expect(topo.semconv.map((s) => [s.namespace, s.version])).toEqual([["gen_ai", "v1.41.1"]]);
      },
    },
    "custom-component": {
      checks: (output) => {
        expect(output.split("\n")[0]).toBe(
          "# chant: exporter splunk_hec/security schema github.com/open-telemetry/opentelemetry-collector-contrib/exporter/splunkhecexporter@v0.130.0",
        );
        const config = clean(output);
        expect(config.exporters?.["splunk_hec/security"]).toMatchObject({ token: "${env:SPLUNK_HEC_TOKEN}", index: "otel" });
      },
    },
  },
);
