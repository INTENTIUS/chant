import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import { otel101 } from "./otel101";
import { otel102 } from "./otel102";
import { otel103 } from "./otel103";
import { otel104 } from "./otel104";
import { otel105 } from "./otel105";
import { otel106 } from "./otel106";
import { otel107 } from "./otel107";
import { otel108 } from "./otel108";
import { otel109 } from "./otel109";
import { otel116 } from "./otel116";
import { otel117 } from "./otel117";
import {
  BatchProcessor,
  DebugExporter,
  FileLogReceiver,
  MemoryLimiterProcessor,
  OtlpReceiver,
  SignalToMetricsConnector,
  type SignalToMetricsConnectorConfig,
} from "../../components";
import { defineComponent } from "../../define";
import { collectorConfigDiagnostics, collectorConfigs } from "./otel-helpers";
import { GENAI_CONTENT_ATTRIBUTES, GENAI_HIGH_CARDINALITY_ATTRIBUTES } from "../../genai";
import { dump } from "js-yaml";
import { Pipeline } from "../../pipeline";

const GOOD = `receivers:
  otlp:
    protocols:
      grpc: {}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
  batch: {}

exporters:
  debug: {}

extensions:
  health_check: {}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
`;

const configChecks = [otel101, otel102, otel103, otel104, otel105, otel106];

function entities(list: unknown[]): Map<string, Declarable> {
  return new Map(list.map((e, i) => [`e${i}`, e as Declarable]));
}

describe("config-level checks on a clean config", () => {
  test.each(configChecks.map((c) => [c.id, c] as const))("%s finds nothing", (_id, check) => {
    expect(check.check(makePostSynthCtx("otel", GOOD))).toEqual([]);
  });
});

describe("OTEL101 undeclared component", () => {
  test("flags an exporter and a processor nobody declares", () => {
    const yaml = GOOD.replace("exporters: [debug]", "exporters: [debug, otlp/backend]").replace(
      "processors: [memory_limiter, batch]",
      "processors: [memory_limiter, batch, attributes/redact]",
    );
    const diags = otel101.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => d.entity)).toEqual(["attributes/redact", "otlp/backend"]);
    expect(diags[0].severity).toBe("error");
  });

  test("accepts a connector id as a receiver or exporter", () => {
    const yaml = `connectors:
  forward: {}
receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [forward]
    traces/2:
      receivers: [forward]
      exporters: [debug]
`;
    expect(otel101.check(makePostSynthCtx("otel", yaml))).toEqual([]);
  });

  test("finds a collector config in another lexicon's output by its shape", () => {
    const yaml = GOOD.replace("exporters: [debug]", "exporters: [nope]");
    expect(otel101.check(makePostSynthCtx("docker", yaml))).toHaveLength(1);
  });
});

describe("OTEL102 empty ends", () => {
  test("flags a pipeline with no receivers and one with no exporters", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: []
      exporters: [debug]
    logs:
      receivers: [otlp]
`;
    const diags = otel102.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => d.message)).toEqual([
      'pipeline "traces" has no receivers, so nothing enters it',
      'pipeline "logs" has no exporters, so what enters it goes nowhere',
    ]);
  });
});

describe("OTEL103 unused", () => {
  test("warns about an unused exporter and an extension never enabled", () => {
    const yaml = GOOD.replace("  debug: {}\n", "  debug: {}\n  otlp/spare:\n    endpoint: x:4317\n").replace(
      "  health_check: {}\n",
      "  health_check: {}\n  zpages: {}\n",
    );
    const diags = otel103.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => [d.entity, d.severity])).toEqual([
      ["otlp/spare", "warning"],
      ["zpages", "warning"],
    ]);
  });
});

describe("OTEL104 undeclared extension", () => {
  test("flags service.extensions naming an extension nobody declares", () => {
    const yaml = GOOD.replace("extensions: [health_check]", "extensions: [health_check, pprof]");
    expect(otel104.check(makePostSynthCtx("otel", yaml)).map((d) => d.entity)).toEqual(["pprof"]);
  });
});

describe("OTEL105 memory_limiter position", () => {
  test("warns when memory_limiter is not first", () => {
    const yaml = GOOD.replace("processors: [memory_limiter, batch]", "processors: [batch, memory_limiter]");
    const diags = otel105.check(makePostSynthCtx("otel", yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });
});

describe("OTEL106 syntax", () => {
  test("flags a pipeline id that names no signal", () => {
    const yaml = GOOD.replace("    traces:\n", "    trace:\n");
    expect(otel106.check(makePostSynthCtx("otel", yaml)).map((d) => d.entity)).toEqual(["trace"]);
  });
});

describe("entity-level checks", () => {
  test("OTEL107 reports a built-in's own config rules", () => {
    const limiter = new MemoryLimiterProcessor({ check_interval: "1s" });
    const logs = new FileLogReceiver({ include: [] });
    const diags = otel107.check(makePostSynthCtx("otel", "", entities([limiter, logs])));
    expect(diags.map((d) => d.entity)).toEqual(["memory_limiter", "filelog"]);
    expect(diags[0].message).toContain("limit_mib or limit_percentage");
  });

  test("OTEL107 is quiet for valid config", () => {
    const limiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80 });
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    expect(otel107.check(makePostSynthCtx("otel", "", entities([limiter, otlp, new BatchProcessor({})])))).toEqual([]);
  });

  test("OTEL107: a signaltometrics entry names exactly one metric type, with a value", () => {
    const good = new SignalToMetricsConnector({
      name: "good",
      spans: [{ name: "span.duration", unit: "ms", histogram: { value: "Milliseconds(end_time - start_time)" } }],
    });
    const bad = new SignalToMetricsConnector({
      name: "bad",
      spans: [{ name: "both", sum: { value: "1" }, gauge: { value: "1" } }, { name: "nothing" }, { name: "h", histogram: { count: "1" } }],
    } as unknown as SignalToMetricsConnectorConfig);
    const diags = otel107.check(makePostSynthCtx("otel", "", entities([good, bad])));
    expect(diags.map((d) => d.entity)).toEqual(["signaltometrics/bad", "signaltometrics/bad", "signaltometrics/bad"]);
    expect(diags.map((d) => d.message.replace(/^.*?\): /, ""))).toEqual([
      "name exactly one metric type (sum, gauge, histogram or exponential_histogram); found sum and gauge",
      "name exactly one metric type (sum, gauge, histogram or exponential_histogram); found none",
      "histogram.value is missing",
    ]);
  });

  test("OTEL108 flags duplicate component and pipeline ids", () => {
    const a = new DebugExporter({});
    const b = new DebugExporter({ verbosity: "detailed" });
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const p1 = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [a] });
    const p2 = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [b] });
    const diags = otel108.check(makePostSynthCtx("otel", "", entities([a, b, otlp, p1, p2])));
    expect(diags.map((d) => d.entity)).toEqual(["debug", "traces"]);
  });

  test("OTEL109 flags a custom component whose pin is unusable", () => {
    const Loose = defineComponent<{ endpoint?: string }>()({
      kind: "exporter",
      type: "loosepin2559",
      pin: { source: "", version: "" },
    });
    const diags = otel109.check(makePostSynthCtx("otel", "", entities([new Loose({})])));
    expect(diags.map((d) => d.checkId)).toEqual(["OTEL109"]);
  });
});

describe("collector configs in Kubernetes ConfigMaps (chant #2930)", () => {
  const manifests = (...docs: object[]) => docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n");
  const configMap = (data: Record<string, string>) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "otel-agent-config", namespace: "observability" }, data });

  test("collectorConfigs reads each ConfigMap value that parses as a config, with its namespace, name and key", () => {
    const ctx = makePostSynthCtx("k8s", manifests(configMap({ "config.yaml": GOOD, "notes.txt": "not a config" }), { apiVersion: "v1", kind: "Service", metadata: { name: "x" } }));
    const found = collectorConfigs(ctx);
    expect(found.map((f) => [f.source, f.configMap])).toEqual([["k8s", { namespace: "observability", name: "otel-agent-config", key: "config.yaml" }]]);
    expect(found[0]?.config.service?.pipelines?.traces?.processors).toEqual(["memory_limiter", "batch"]);
  });

  test("a config-level check reports a ConfigMap config's issue, naming the ConfigMap and key", () => {
    const broken = GOOD.replace("exporters: [debug]", "exporters: [debug, otlp/backend]");
    const diags = otel101.check(makePostSynthCtx("k8s", manifests(configMap({ "config.yaml": broken }))));
    expect(diags.map((d) => d.checkId)).toEqual(["OTEL101"]);
    expect(diags[0].message).toMatch(/^ConfigMap observability\/otel-agent-config, key config\.yaml: /);
  });
});


describe("OTEL116 high-cardinality GenAI attributes as metric attributes", () => {
  /** A config whose connectors split metrics by the given keys, in every field OTEL116 reads. */
  function connectorsSplitBy(key: string) {
    return {
      receivers: { otlp: { protocols: { grpc: {} } } },
      exporters: { debug: {} },
      connectors: {
        spanmetrics: {
          dimensions: [{ name: key }],
          calls_dimensions: [{ name: key }],
          histogram: { dimensions: [{ name: key }] },
          events: { enabled: true, dimensions: [{ name: key }] },
        },
        servicegraph: { dimensions: [key] },
        count: { spans: { "genai.calls": { attributes: [{ key }] } } },
        "sum/genai": { spans: { "genai.tokens": { source_attribute: "gen_ai.usage.input_tokens", attributes: [{ key, default_value: "none" }] } } },
        signaltometrics: {
          spans: [{ name: "gen_ai.client.operation.duration", histogram: { value: "Seconds(end_time - start_time)" }, attributes: [{ key }], include_resource_attributes: [{ key }] }],
        },
      },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["spanmetrics", "servicegraph", "count", "sum/genai", "signaltometrics"] },
          metrics: { receivers: ["spanmetrics", "servicegraph", "count", "sum/genai", "signaltometrics"], exporters: ["debug"] },
        },
      },
    };
  }
  const FIELDS = [
    ["spanmetrics", "dimensions"],
    ["spanmetrics", "calls_dimensions"],
    ["spanmetrics", "histogram.dimensions"],
    ["spanmetrics", "events.dimensions"],
    ["servicegraph", "dimensions"],
    ["count", "spans.genai.calls.attributes"],
    ["sum/genai", "spans.genai.tokens.attributes"],
    ["signaltometrics", "spans[0] (gen_ai.client.operation.duration).attributes"],
    ["signaltometrics", "spans[0] (gen_ai.client.operation.duration).include_resource_attributes"],
  ];
  const run = (config: object, lexicon = "otel") => otel116.check(makePostSynthCtx(lexicon, dump(config, { lineWidth: -1 })));

  test.each(GENAI_HIGH_CARDINALITY_ATTRIBUTES.map((k) => [k]))("reports %s in every connector field", (key) => {
    const diags = run(connectorsSplitBy(key));
    expect(diags.map((d) => [d.entity, d.message.match(/\((.+)\);/)?.[1]])).toEqual(FIELDS);
    expect(diags.every((d) => d.checkId === "OTEL116" && d.severity === "warning")).toBe(true);
    expect(diags[0].message).toContain(`"${key}"`);
    expect(diags[0].message).toContain("new value per request");
  });

  test.each([...GENAI_CONTENT_ATTRIBUTES, "gen_ai.prompt.0.content"].map((k) => [k]))("reports content key %s as unbounded and sensitive", (key) => {
    const diags = run(connectorsSplitBy(key));
    expect(diags).toHaveLength(FIELDS.length);
    expect(diags[0].message).toContain("unbounded and sensitive");
  });

  test.each(["gen_ai.request.model", "gen_ai.provider.name", "gen_ai.prompt.name", "error.type"].map((k) => [k]))("passes bounded key %s", (key) => {
    expect(run(connectorsSplitBy(key))).toEqual([]);
  });

  test("passes the v1.41.1 client metrics' attributes, and an empty include_resource_attributes", () => {
    const semconv = ["gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model", "server.address", "server.port", "error.type", "gen_ai.token.type"];
    const config = {
      ...connectorsSplitBy("gen_ai.request.model"),
      connectors: {
        signaltometrics: {
          spans: [
            {
              name: "gen_ai.client.token.usage",
              histogram: { value: 'attributes["gen_ai.usage.input_tokens"]' },
              attributes: semconv.map((key) => ({ key, optional: true })),
              include_resource_attributes: [],
            },
          ],
        },
      },
      service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["signaltometrics"] }, metrics: { receivers: ["signaltometrics"], exporters: ["debug"] } } },
    };
    expect(run(config)).toEqual([]);
  });

  test("WK8604's entry point reports it for a config in a ConfigMap", () => {
    const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "otel-agent-config", namespace: "observability" }, data: { "config.yaml": dump(connectorsSplitBy("gen_ai.conversation.id")) } };
    const diags = collectorConfigDiagnostics(makePostSynthCtx("k8s", dump(configMap, { lineWidth: -1 })), { configMapsOnly: true }).filter((d) => d.checkId === "OTEL116");
    expect(diags).toHaveLength(FIELDS.length);
    expect(diags[0].message).toMatch(/^ConfigMap observability\/otel-agent-config, key config\.yaml: connector "spanmetrics" splits metrics by "gen_ai\.conversation\.id"/);
  });
});

describe("OTEL117 two started components on one address", () => {
  const run = (config: object) => otel117.check(makePostSynthCtx("otel", dump(config)));
  const otlpOnly = { receivers: ["otlp"], exporters: ["debug"] };

  test("reports a prometheus exporter on the collector's own default metrics port", () => {
    const diags = run({
      receivers: { otlp: { protocols: { grpc: { endpoint: "0.0.0.0:4317" } } } },
      exporters: { prometheus: { endpoint: "0.0.0.0:8888" } },
      service: { pipelines: { metrics: { receivers: ["otlp"], exporters: ["prometheus"] } } },
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "OTEL117", severity: "error" });
    expect(diags[0].message).toContain('exporter "prometheus" (endpoint) listens on 0.0.0.0:8888');
    expect(diags[0].message).toContain("the collector's own metrics (service.telemetry.metrics, by default) on localhost:8888");
  });

  test("reports two otlp receivers left on the default grpc port", () => {
    const diags = run({
      receivers: { otlp: { protocols: { grpc: {} } }, "otlp/2": { protocols: { grpc: {}, http: { endpoint: "0.0.0.0:4319" } } } },
      exporters: { debug: {} },
      service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] }, logs: { receivers: ["otlp/2"], exporters: ["debug"] } } },
    });
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringMatching(/^receiver "otlp" \(protocols\.grpc\.endpoint\) listens on localhost:4317 and receiver "otlp\/2" \(protocols\.grpc\.endpoint\) on localhost:4317/),
    ]);
  });

  test("knows the contrib push receivers' defaults: carbon and wavefront both take localhost:2003 (#3122)", () => {
    const diags = run({
      receivers: { carbon: {}, wavefront: {}, "carbon/udp": { transport: "udp" } },
      exporters: { debug: {} },
      service: { pipelines: { metrics: { receivers: ["carbon", "wavefront", "carbon/udp"], exporters: ["debug"] } } },
    });
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringMatching(/^receiver "carbon" \(endpoint\) listens on localhost:2003 and receiver "wavefront" \(endpoint\) on localhost:2003/),
    ]);
  });

  test("a wildcard host overlaps a specific host on the same port, and an extension counts", () => {
    const diags = run({
      receivers: { zipkin: { endpoint: "127.0.0.1:13133" } },
      exporters: { debug: {} },
      extensions: { health_check: { endpoint: "0.0.0.0:13133" } },
      service: { extensions: ["health_check"], pipelines: { traces: { receivers: ["zipkin"], exporters: ["debug"] } } },
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('extension "health_check" (endpoint) on 0.0.0.0:13133');
  });

  test("passes different hosts on one port, UDP beside TCP, and telemetry moved off 8888 or turned off", () => {
    const base = {
      receivers: {
        otlp: { protocols: { grpc: { endpoint: "10.0.0.1:4317" }, http: { endpoint: "0.0.0.0:6831" } } },
        "otlp/b": { protocols: { grpc: { endpoint: "10.0.0.2:4317" } } },
        jaeger: { protocols: { thrift_compact: {} } },
      },
      exporters: { prometheus: { endpoint: "0.0.0.0:8888" } },
    };
    const pipelines = { traces: { receivers: ["otlp", "otlp/b", "jaeger"], exporters: ["prometheus"] } };
    const reader = { pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8889 } } } };
    expect(run({ ...base, service: { telemetry: { metrics: { readers: [reader] } }, pipelines } })).toEqual([]);
    expect(run({ ...base, service: { telemetry: { metrics: { level: "none" } }, pipelines } })).toEqual([]);
  });

  test("a component nothing starts doesn't count, nor does an endpoint the collector connects to", () => {
    expect(
      run({
        receivers: { otlp: { protocols: { grpc: {} } }, "otlp/unused": { protocols: { grpc: {} } }, kubeletstats: { endpoint: "localhost:4317" } },
        exporters: { debug: {}, prometheus: { endpoint: "localhost:8888" }, otlp: { endpoint: "localhost:4317" } },
        extensions: { zpages: { endpoint: "localhost:4317" } },
        service: { pipelines: { traces: otlpOnly, metrics: { receivers: ["kubeletstats"], exporters: ["otlp"] } } },
      }),
    ).toEqual([]);
  });

  test("a kubeletstats endpoint on a wildcard listener's port is not a collision (#3102)", () => {
    expect(
      run({
        receivers: {
          otlp: { protocols: { http: { endpoint: "0.0.0.0:10250" } } },
          kubeletstats: { auth_type: "serviceAccount", endpoint: "https://${env:K8S_NODE_NAME}:10250" },
        },
        exporters: { debug: {} },
        service: { pipelines: { metrics: { receivers: ["otlp", "kubeletstats"], exporters: ["debug"] } } },
      }),
    ).toEqual([]);
  });

  test("reads the telemetry reader's address when one is set", () => {
    const diags = run({
      receivers: { otlp: { protocols: { http: { endpoint: "0.0.0.0:9000" } } } },
      exporters: { debug: {} },
      service: { telemetry: { metrics: { readers: [{ pull: { exporter: { prometheus: { host: "0.0.0.0", port: 9000 } } } }] } }, pipelines: { logs: { receivers: ["otlp"], exporters: ["debug"] } } },
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("service.telemetry.metrics.readers[0]");
  });

  test("WK8604's entry point reports it for a config in a ConfigMap", () => {
    const config = { receivers: { otlp: { protocols: { grpc: {} } } }, exporters: { prometheus: { endpoint: ":8888" } }, service: { pipelines: { metrics: { receivers: ["otlp"], exporters: ["prometheus"] } } } };
    const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "otel-agent-config", namespace: "observability" }, data: { "config.yaml": dump(config) } };
    const diags = collectorConfigDiagnostics(makePostSynthCtx("k8s", dump(configMap, { lineWidth: -1 })), { configMapsOnly: true }).filter((d) => d.checkId === "OTEL117");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/^ConfigMap observability\/otel-agent-config, key config\.yaml: exporter "prometheus"/);
  });
});
