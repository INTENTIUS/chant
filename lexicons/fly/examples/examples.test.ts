import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { load } from "js-yaml";
import { flySerializer } from "@intentius/chant-lexicon-fly";
import { validateCollectorConfig, COLLECTOR_CONFIG_PATH, type CollectorConfig } from "@intentius/chant-lexicon-otel";

describeAllExamples(
  {
    lexicon: "fly",
    serializer: flySerializer,
    outputKey: "fly",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        expect(output).toContain('"app_name": "my-app"');
        expect(output).toContain('"endpoint": "/v1/apps"');
        expect(output).toContain('"image": "flyio/hellofly:latest"');
      },
    },
    "otel-collector": {
      checks: (output) => {
        const bodies = JSON.parse(output) as Record<string, { endpoint: string; body: Record<string, any> }>;
        const machine = Object.values(bodies).find((b) => b.endpoint.endsWith("/machines"))!;
        expect(machine.endpoint).toBe("/v1/apps/otel-collector/machines");
        const config = machine.body.config;
        expect(config.init.cmd).toEqual([`--config=${COLLECTOR_CONFIG_PATH}`]);
        expect(config.checks.health).toMatchObject({ type: "http", port: 13133, path: "/" });

        // The collector config travels as a base64 file on the machine.
        const [file] = config.files;
        expect(file.guest_path).toBe(COLLECTOR_CONFIG_PATH);
        const collector = load(Buffer.from(file.raw_value, "base64").toString("utf8")) as CollectorConfig;
        expect(validateCollectorConfig(collector)).toEqual([]);
        expect(collector.exporters).toEqual({
          otlphttp: { endpoint: "https://otlp.example.com", headers: { "x-api-key": "${env:OTLP_API_KEY}" } },
        });
      },
    },
  },
);
