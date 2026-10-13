import { expect } from "vitest";
import { load } from "js-yaml";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { validateCollectorConfig, type CollectorConfig } from "@intentius/chant-lexicon-otel";

describeAllExamples(
  {
    lexicon: "docker",
    serializer: dockerSerializer,
    outputKey: "docker",
    examplesDir: import.meta.dirname,
  },
  {
    "basic-app": {
      // Predates this test; its lint warnings (COR001, COR004) are its own.
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("image: postgres:16-alpine");
      },
    },
    "otel-collector": {
      checks: (output) => {
        const compose = load(output) as {
          services: Record<string, Record<string, unknown>>;
          configs: Record<string, { content: string }>;
        };
        const service = compose.services.otelService;
        expect(service.command).toEqual(["--config=/etc/otel/config.yaml"]);
        expect(service.configs).toEqual([{ source: "otelConfig", target: "/etc/otel/config.yaml" }]);
        expect(service.ports).toEqual(["4317:4317", "4318:4318"]);

        const config = load(compose.configs.otelConfig.content) as CollectorConfig;
        expect(validateCollectorConfig(config)).toEqual([]);
        expect(config.exporters).toEqual({ "otlp/jaeger": { endpoint: "jaeger:4317", tls: { insecure: true } } });
        expect(Object.keys(config.service?.pipelines ?? {})).toEqual(["traces"]);
      },
    },
  },
);
