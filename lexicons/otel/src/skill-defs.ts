import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";

/** The otel lexicon's AI skills, read from src/skills/. */
export const otelSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-otel.md",
    name: "chant-otel",
    description: "Declare OpenTelemetry Collector config (receivers, processors, exporters, pipelines) as typed chant entities and build collector YAML",
    triggers: [
      { type: "context" as const, value: "opentelemetry" },
      { type: "context" as const, value: "otel collector" },
      { type: "file-pattern" as const, value: "*.otel.ts" },
    ],
    examples: [
      {
        title: "An OTLP-in, OTLP-out traces pipeline",
        output:
          'const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });\n' +
          'const backend = new OtlpExporter({ name: "backend", endpoint: "tempo:4317" });\n' +
          "export const traces = new Pipeline({ signal: \"traces\", receivers: [otlp], exporters: [backend] });",
      },
    ],
  },
  {
    file: "chant-otel-custom-components.md",
    name: "chant-otel-custom-components",
    description: "Add a collector component chant doesn't ship (a vendor exporter, an in-house processor) with defineComponent, and pin its schema",
    triggers: [{ type: "context" as const, value: "otel custom component" }],
  },
  {
    file: "chant-otel-platforms.md",
    name: "chant-otel-platforms",
    description: "Run a declared collector config on Kubernetes, GKE, Docker or Fly by rendering it into the platform's own config file",
    triggers: [{ type: "context" as const, value: "deploy otel collector" }],
  },
]);
