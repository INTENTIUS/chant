import { describe, expect, test } from "vitest";
import { COLLECTOR_RESOURCE_TYPE, OtelCollectorParser, parseCollectorYaml } from "./parser";

const parser = new OtelCollectorParser();

describe("parseCollectorYaml", () => {
  test("reads every section as the collector's own layout", () => {
    const { config, warnings } = parseCollectorYaml(`
receivers:
  otlp:
    protocols:
      grpc:
processors:
  batch:
exporters:
  otlp/tempo:
    endpoint: tempo:4317
connectors:
  forward/x: {}
extensions:
  health_check:
service:
  extensions: [health_check]
  telemetry:
    logs: { level: debug }
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo, forward/x]
`);
    expect(warnings).toEqual([]);
    expect(config.receivers).toEqual({ otlp: { protocols: { grpc: null } } });
    expect(config.processors).toEqual({ batch: null });
    expect(config.exporters).toEqual({ "otlp/tempo": { endpoint: "tempo:4317" } });
    expect(config.connectors).toEqual({ "forward/x": {} });
    expect(config.extensions).toEqual({ health_check: null });
    expect(config.service).toEqual({
      extensions: ["health_check"],
      telemetry: { logs: { level: "debug" } },
      pipelines: { traces: { receivers: ["otlp"], processors: ["batch"], exporters: ["otlp/tempo", "forward/x"] } },
    });
  });

  test("keeps ${env:VAR} references and quoted scalars as strings", () => {
    const { config } = parseCollectorYaml(`
exporters:
  otlphttp:
    endpoint: \${env:OTLP_ENDPOINT}
    headers:
      api-key: "\${env:API_KEY}"
    compression: "none"
  prometheus:
    endpoint: "0.0.0.0:8889"
    const_labels:
      port: "8080"
      started: 2024-01-01
`);
    expect(config.exporters?.otlphttp).toEqual({
      endpoint: "${env:OTLP_ENDPOINT}",
      headers: { "api-key": "${env:API_KEY}" },
      compression: "none",
    });
    // No YAML 1.1 dates: the collector reads this as a string, and so does the importer.
    expect(config.exporters?.prometheus).toEqual({ endpoint: "0.0.0.0:8889", const_labels: { port: "8080", started: "2024-01-01" } });
  });

  test("resolves anchors and merge keys", () => {
    const { config } = parseCollectorYaml(`
exporters:
  otlp/a: &base
    endpoint: a:4317
    tls: { insecure: true }
  otlp/b:
    <<: *base
    endpoint: b:4317
`);
    expect(config.exporters?.["otlp/b"]).toEqual({ endpoint: "b:4317", tls: { insecure: true } });
  });

  test("reads the # chant: header back", () => {
    const { pins, semconv, warnings } = parseCollectorYaml(
      [
        "# chant: exporter splunk_hec/security schema github.com/open-telemetry/opentelemetry-collector-contrib/exporter/splunkhecexporter@v0.130.0",
        "# chant: processor acme schema @acme/otel-components@1.2.3 sha256:deadbeef",
        "# chant: semconv gen_ai github.com/open-telemetry/semantic-conventions@v1.41.1 (transform, redaction)",
        "receivers: {}",
      ].join("\n"),
    );
    expect(pins).toEqual([
      {
        kind: "exporter",
        id: "splunk_hec/security",
        pin: { source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/splunkhecexporter", version: "v0.130.0" },
      },
      { kind: "processor", id: "acme", pin: { source: "@acme/otel-components", version: "1.2.3", digest: "sha256:deadbeef" } },
    ]);
    expect(semconv).toEqual([{ namespace: "gen_ai", pin: { source: "github.com/open-telemetry/semantic-conventions", version: "v1.41.1" } }]);
    expect(warnings).toEqual([]);
  });

  test("only the leading comment block is a header, and an unpinned line pins nothing", () => {
    const { pins } = parseCollectorYaml(
      [
        "# chant: exporter x schema (unpinned)@(unpinned)",
        "receivers: {}",
        "# chant: exporter y schema src@v1",
      ].join("\n"),
    );
    expect(pins).toEqual([]);
  });

  test("names what it cannot carry", () => {
    const { config, warnings } = parseCollectorYaml(
      [
        "# chant: semconv gen_ai github.com/open-telemetry/semantic-conventions@v1.30.0 (x)",
        "# chant: something else",
        "receivers:",
        "  thing:",
        "    name: dropped",
        "    other: kept",
        "  bad id: {}",
        "exporters:",
        "  debug: 3",
        "connectors: []",
        "extras: {}",
        "service:",
        "  pipelines:",
        "    profiles:",
        "      receivers: [thing]",
        "      exporters: [debug]",
        "      extra: [x]",
        "  unknown: true",
      ].join("\n"),
    );
    expect(warnings).toEqual([
      "the config was built against gen_ai semantic conventions github.com/open-telemetry/semantic-conventions@v1.30.0; this lexicon follows github.com/open-telemetry/semantic-conventions@v1.41.1, which the rebuilt config will name",
      'header line "# chant: something else" is not a schema pin chant recognises; it is not carried',
      'receivers.thing has a config key "name", which chant uses for the instance name; the key is not carried',
      'receivers: "bad id" is not a type[/name] component id',
      "exporters.debug is not a mapping; it is carried as an empty config",
      '"connectors" is not a mapping; it is not carried',
      'top-level section "extras" is not part of a collector config; it is not carried',
      'pipeline "profiles" carries signal "profiles", which Pipeline does not type; it is imported with a type suppression',
      "service.pipelines.profiles.extra is not carried; a Pipeline has receivers, processors and exporters",
      "service.unknown is not carried; chant's Service declares extensions and telemetry",
    ]);
    expect(config.receivers?.thing).toEqual({ name: "dropped", other: "kept" });
  });

  test("an empty file is an empty config; a non-mapping is an error", () => {
    expect(parseCollectorYaml("").config).toEqual({});
    expect(parseCollectorYaml("# just a comment\n").config).toEqual({});
    expect(() => parseCollectorYaml("- a\n- b\n")).toThrow(/is a YAML mapping/);
  });
});

describe("OtelCollectorParser", () => {
  test("carries the whole config as one OTel::Collector resource, with the header in metadata", () => {
    const ir = parser.parse(
      "# chant: exporter x/y schema src@v1\nexporters:\n  x/y: {}\nservice:\n  pipelines:\n    logs:\n      receivers: []\n      exporters: [x/y]\n",
    );
    expect(ir.resources).toHaveLength(1);
    const [r] = ir.resources;
    expect(r.type).toBe(COLLECTOR_RESOURCE_TYPE);
    expect(r.logicalId).toBe("collector");
    expect(r.properties).toEqual({
      config: { exporters: { "x/y": {} }, service: { pipelines: { logs: { receivers: [], exporters: ["x/y"] } } } },
    });
    expect(r.metadata).toEqual({ pins: [{ kind: "exporter", id: "x/y", pin: { source: "src", version: "v1" } }], semconv: [] });
    expect(ir.parameters).toEqual([]);
    expect(ir.warnings).toEqual([]);
  });
});
