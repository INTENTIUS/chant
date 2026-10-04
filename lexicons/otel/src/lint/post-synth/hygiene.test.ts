import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { dump, load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { otel119 } from "./otel119";
import { otel120 } from "./otel120";
import { otel121 } from "./otel121";
import { otel122 } from "./otel122";
import { otel123 } from "./otel123";
import { otel124 } from "./otel124";
import { otel125 } from "./otel125";
import { otel126 } from "./otel126";
import { otel127 } from "./otel127";
import { collectorConfigDiagnostics } from "./otel-helpers";
import { collectorYaml } from "../../collector";
import { otlpCollector } from "../../platform";
import { genAiPipeline } from "../../genai";
import { NodeAgent } from "../../composites";
import { OtlpExporter, OtlpHttpExporter, PrometheusExporter } from "../../components";
import { validateCollectorConfig } from "../../validate-config";
import type { CollectorConfig } from "../../model";

const run = (check: { check: typeof otel119.check }, config: object) => check.check(makePostSynthCtx("otel", dump(config, { lineWidth: -1 })));
const HYGIENE = ["OTEL119", "OTEL120", "OTEL121", "OTEL122", "OTEL123", "OTEL124", "OTEL125", "OTEL126", "OTEL127"];

/** A started otlp receiver and the given exporters, all in one traces pipeline with batch. */
function withExporters(exporters: Record<string, object>, extra: { processors?: string[] } = {}) {
  return {
    receivers: { otlp: { protocols: { grpc: {} } } },
    processors: { batch: {} },
    exporters,
    service: { pipelines: { traces: { receivers: ["otlp"], processors: extra.processors ?? ["batch"], exporters: Object.keys(exporters) } } },
  };
}

describe("OTEL119 deprecated fields", () => {
  const tailSampling = (policies: object[]) => ({
    receivers: { otlp: { protocols: { grpc: {} } } },
    processors: { tail_sampling: { policies } },
    exporters: { debug: {} },
    service: { pipelines: { traces: { receivers: ["otlp"], processors: ["tail_sampling"], exporters: ["debug"] } } },
  });

  test("reports invert_match: true in a policy and in a sub-policy", () => {
    const diags = run(
      otel119,
      tailSampling([
        { name: "not-health", type: "string_attribute", string_attribute: { key: "http.route", values: ["/health"], invert_match: true } },
        { name: "and", type: "and", and: { and_sub_policy: [{ name: "n", type: "numeric_attribute", numeric_attribute: { key: "k", min_value: 1, invert_match: true } }] } },
      ]),
    );
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('policy "not-health" sets string_attribute.invert_match; inverted decisions are deprecated since collector-contrib v0.126.0'),
      expect.stringContaining('policy "and" sets and.and_sub_policy[0].numeric_attribute.invert_match'),
    ]);
    expect(diags.every((d) => d.checkId === "OTEL119" && d.severity === "warning" && d.entity === "tail_sampling")).toBe(true);
  });

  test("passes invert_match: false and a drop policy", () => {
    expect(
      run(
        otel119,
        tailSampling([
          { name: "a", type: "boolean_attribute", boolean_attribute: { key: "k", value: true, invert_match: false } },
          { name: "drop-health", type: "drop", drop: { drop_sub_policy: [{ name: "h", type: "string_attribute", string_attribute: { key: "http.route", values: ["/health"] } }] } },
        ]),
      ),
    ).toEqual([]);
  });

  test("reports service.telemetry.metrics.address and passes readers", () => {
    const base = withExporters({ debug: {} });
    const address = run(otel119, { ...base, service: { ...base.service, telemetry: { metrics: { address: "localhost:8889" } } } });
    expect(address).toHaveLength(1);
    expect(address[0].message).toContain("deprecated since collector v0.111.0");
    const readers = { readers: [{ pull: { exporter: { prometheus: { host: "localhost", port: 8889 } } } }] };
    expect(run(otel119, { ...base, service: { ...base.service, telemetry: { metrics: readers } } })).toEqual([]);
  });

  test("reports spanmetrics dimensions_cache_size", () => {
    const config = {
      receivers: { otlp: { protocols: { grpc: {} } } },
      exporters: { debug: {} },
      connectors: { "spanmetrics/a": { dimensions_cache_size: 1000 }, "spanmetrics/b": { aggregation_cardinality_limit: 1000 } },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["spanmetrics/a", "spanmetrics/b"] },
          metrics: { receivers: ["spanmetrics/a", "spanmetrics/b"], exporters: ["debug"] },
        },
      },
    };
    const diags = run(otel119, config);
    expect(diags.map((d) => d.entity)).toEqual(["spanmetrics/a"]);
    expect(diags[0].message).toContain("aggregation_cardinality_limit");
  });
});

describe("OTEL120 literal credential in the config", () => {
  test("reports a literal header, key and nested password, as an error", () => {
    const diags = run(
      otel120,
      withExporters({
        "otlphttp/vendor": { endpoint: "https://api.vendor.example", headers: { authorization: "Bearer abc123" } },
        "splunk_hec/x": { endpoint: "https://splunk.example:8088", token: "00000000-0000" },
      }),
    );
    expect(diags.map((d) => [d.entity, d.message.match(/at (\S+);/)?.[1]])).toEqual([
      ["otlphttp/vendor", "headers.authorization"],
      ["splunk_hec/x", "token"],
    ]);
    expect(diags[0]).toMatchObject({ checkId: "OTEL120", severity: "error" });
  });

  test("looks in every section and inside lists", () => {
    const config = {
      receivers: { prometheus: { config: { scrape_configs: [{ job_name: "x", basic_auth: { username: "u", password: "hunter2" } }] } } },
      exporters: { debug: {} },
      extensions: { bearertokenauth: { token: "literal" } },
      service: { extensions: ["bearertokenauth"], pipelines: { metrics: { receivers: ["prometheus"], exporters: ["debug"] } } },
    };
    expect(run(otel120, config).map((d) => d.message.match(/at (\S+);/)?.[1])).toEqual(["config.scrape_configs.basic_auth.password", "token"]);
  });

  test("passes ${env:...} and ${file:...} references, _file keys, and empty values", () => {
    expect(
      run(
        otel120,
        withExporters({
          "otlphttp/vendor": { endpoint: "https://api.vendor.example", headers: { authorization: "Bearer ${env:TOKEN}", "api-key": "${file:/secrets/key}" } },
          "otlp/b": { endpoint: "backend:4317", tls: { ca_file: "/ca.pem", key_file: "/key.pem" }, headers: { "x-api-key": "" } },
        }),
      ),
    ).toEqual([]);
  });

  test("WK8604's entry point reports it for a config in a ConfigMap", () => {
    const config = withExporters({ "otlphttp/vendor": { endpoint: "https://api.vendor.example", headers: { "api-key": "abc" } } });
    const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "otel-config", namespace: "observability" }, data: { "config.yaml": dump(config) } };
    const diags = collectorConfigDiagnostics(makePostSynthCtx("k8s", dump(configMap, { lineWidth: -1 })), { configMapsOnly: true }).filter((d) => d.checkId === "OTEL120");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/^ConfigMap observability\/otel-config, key config\.yaml: exporter "otlphttp\/vendor" has a literal credential at headers\.api-key/);
  });
});

describe("OTEL121 credential over plaintext", () => {
  test("reports an auth header over tls.insecure and an api key over http://", () => {
    const diags = run(
      otel121,
      withExporters({
        "otlp/gw": { endpoint: "gateway.observability.svc:4317", tls: { insecure: true }, headers: { authorization: "Bearer ${env:TOKEN}" } },
        "otlphttp/v": { endpoint: "http://vendor.example:4318", headers: { "x-api-key": "${env:KEY}" } },
      }),
    );
    expect(diags.map((d) => [d.entity, d.severity])).toEqual([
      ["otlp/gw", "warning"],
      ["otlphttp/v", "warning"],
    ]);
    expect(diags[0].message).toContain("sends headers.authorization to gateway.observability.svc:4317 over tls.insecure: true");
    expect(diags[1].message).toContain("over an http:// endpoint");
  });

  test("passes TLS, a credential-free plaintext exporter, loopback, and https with tls.insecure", () => {
    expect(
      run(
        otel121,
        withExporters({
          "otlp/tls": { endpoint: "backend:4317", headers: { authorization: "Bearer ${env:T}" } },
          "otlp/plain": { endpoint: "tempo:4317", tls: { insecure: true } },
          "otlphttp/local": { endpoint: "http://localhost:4318", headers: { authorization: "Bearer ${env:T}" } },
          "otlphttp/https": { endpoint: "https://vendor.example", tls: { insecure: true }, headers: { authorization: "Bearer ${env:T}" } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("OTEL122 zpages and pprof off loopback", () => {
  const withExtensions = (extensions: Record<string, object>, enabled = Object.keys(extensions)) => ({
    ...withExporters({ debug: {} }),
    extensions,
    service: { extensions: enabled, pipelines: { traces: { receivers: ["otlp"], processors: ["batch"], exporters: ["debug"] } } },
  });

  test("reports zpages on 0.0.0.0 and pprof on a pod IP", () => {
    const diags = run(otel122, withExtensions({ zpages: { endpoint: "0.0.0.0:55679" }, "pprof/x": { endpoint: "${env:POD_IP}:1777" } }));
    expect(diags.map((d) => [d.entity, d.severity])).toEqual([
      ["zpages", "warning"],
      ["pprof/x", "warning"],
    ]);
    expect(diags[0].message).toContain("listens on 0.0.0.0:55679");
  });

  test("passes the localhost defaults, 127.0.0.1, an extension that never starts, and health_check on 0.0.0.0", () => {
    expect(
      run(
        otel122,
        withExtensions(
          { zpages: {}, pprof: { endpoint: "127.0.0.1:1777" }, "zpages/off": { endpoint: "0.0.0.0:55680" }, health_check: { endpoint: "0.0.0.0:13133" } },
          ["zpages", "pprof", "health_check"],
        ),
      ),
    ).toEqual([]);
  });
});

describe("OTEL123 detailed debug beside a real exporter", () => {
  test("reports debug at detailed in a pipeline that also sends to a backend", () => {
    const diags = run(otel123, withExporters({ debug: { verbosity: "detailed" }, "otlp/b": { endpoint: "backend:4317" } }));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "OTEL123", severity: "warning", entity: "debug" });
    expect(diags[0].message).toContain('exports to "otlp/b" and to "debug" at verbosity: detailed');
  });

  test("passes detailed debug on its own, and basic debug beside a backend", () => {
    expect(run(otel123, withExporters({ debug: { verbosity: "detailed" } }))).toEqual([]);
    expect(run(otel123, withExporters({ debug: { verbosity: "basic" }, "otlp/b": { endpoint: "backend:4317" } }))).toEqual([]);
  });
});

describe("OTEL124 queue or retry off for a remote exporter", () => {
  test("reports each one turned off", () => {
    const diags = run(otel124, withExporters({ "otlp/b": { endpoint: "backend:4317", sending_queue: { enabled: false }, retry_on_failure: { enabled: false } } }));
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining("sending_queue.enabled: false"),
      expect.stringContaining("retry_on_failure.enabled: false"),
    ]);
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
  });

  test("passes a loopback endpoint, a prometheus exporter, and the defaults", () => {
    expect(
      run(
        otel124,
        withExporters({
          "otlp/sidecar": { endpoint: "localhost:4317", sending_queue: { enabled: false } },
          prometheus: { endpoint: "0.0.0.0:8889", sending_queue: { enabled: false } },
          "otlp/b": { endpoint: "backend:4317", sending_queue: { enabled: true, queue_size: 5000 } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("OTEL125 no batching before a remote otlp exporter", () => {
  test("reports otlp and otlphttp in a pipeline with no batch processor", () => {
    const diags = run(otel125, withExporters({ "otlp/b": { endpoint: "backend:4317" }, otlphttp: { endpoint: "${env:OTLP_ENDPOINT}" } }, { processors: [] }));
    expect(diags.map((d) => [d.entity, d.severity])).toEqual([
      ["otlp/b", "warning"],
      ["otlphttp", "warning"],
    ]);
    expect(diags[0].message).toContain('pipeline "traces" sends to "otlp/b" (backend:4317) with no batch processor');
  });

  test("passes a batch processor, named or not, sending_queue.batch, loopback, and other exporters", () => {
    expect(run(otel125, withExporters({ "otlp/b": { endpoint: "backend:4317" } }))).toEqual([]);
    const named = withExporters({ "otlp/b": { endpoint: "backend:4317" } }, { processors: ["batch/big"] });
    expect(run(otel125, { ...named, processors: { "batch/big": {} } })).toEqual([]);
    expect(
      run(
        otel125,
        withExporters(
          {
            "otlp/q": { endpoint: "backend:4317", sending_queue: { batch: { flush_timeout: "1s" } } },
            "otlp/local": { endpoint: "127.0.0.1:4317" },
            "splunk_hec/x": { endpoint: "https://splunk.example:8088" },
          },
          { processors: [] },
        ),
      ),
    ).toEqual([]);
  });
});

describe("OTEL126 k8sattributes metadata fields", () => {
  const k8s = (metadata: string[]) => ({
    ...withExporters({ debug: {} }),
    processors: { k8sattributes: { extract: { metadata } } },
    service: { pipelines: { traces: { receivers: ["otlp"], processors: ["k8sattributes"], exporters: ["debug"] } } },
  });

  test("reports a field k8sattributes can't extract, as an error", () => {
    const diags = run(otel126, k8s(["k8s.pod.name", "k8s.pod.labels", "k8s.namespace.uid"]));
    expect(diags.map((d) => d.message.match(/extracts "([^"]+)"/)?.[1])).toEqual(["k8s.pod.labels", "k8s.namespace.uid"]);
    expect(diags[0]).toMatchObject({ checkId: "OTEL126", severity: "error", entity: "k8sattributes" });
  });

  test("passes every supported field", async () => {
    const { K8S_ATTRIBUTES_METADATA } = await import("../../config-hygiene");
    expect(run(otel126, k8s([...K8S_ATTRIBUTES_METADATA]))).toEqual([]);
  });
});

describe("OTEL127 resourcedetection detectors", () => {
  const rd = (detectors: string[], started = true) => ({
    ...withExporters({ debug: {} }),
    processors: { resourcedetection: { detectors } },
    service: { pipelines: { traces: { receivers: ["otlp"], processors: started ? ["resourcedetection"] : [], exporters: ["debug"] } } },
  });

  test("reports an unknown detector, with a hint for elasticbeanstalk", () => {
    const diags = run(otel127, rd(["env", "elasticbeanstalk", "k8s"]));
    expect(diags.map((d) => d.message.match(/detector "([^"]+)"/)?.[1])).toEqual(["elasticbeanstalk", "k8s"]);
    expect(diags[0].message).toContain('(the detector is "elastic_beanstalk")');
    expect(diags[0]).toMatchObject({ checkId: "OTEL127", severity: "error" });
  });

  test("passes every registered detector, an ${env:...} entry, and a processor nothing starts", async () => {
    const { RESOURCE_DETECTORS } = await import("../../config-hygiene");
    expect(run(otel127, rd([...RESOURCE_DETECTORS, "${env:DETECTORS}"]))).toEqual([]);
    expect(run(otel127, rd(["nope"], false))).toEqual([]);
  });
});

// The issue's acceptance bar: what chant itself produces reports none of these.
// The init templates and examples are covered by init-templates.test.ts and
// examples/examples.test.ts, which require every check to pass.
describe("OTEL119-OTEL127 on chant's own collector configs", () => {
  const backend = () => new OtlpExporter({ name: "backend", endpoint: "tempo:4317", tls: { insecure: true } });
  const configs: Array<[string, () => Declarable[]]> = [
    ["otlpCollector()", () => otlpCollector()],
    ["otlpCollector() to an otlp backend", () => otlpCollector({ exporters: [backend()] })],
    ["genAiPipeline()", () => genAiPipeline()],
    [
      "genAiPipeline() to otlp backends",
      () => genAiPipeline({ traceExporters: [backend()], metricExporters: [new OtlpHttpExporter({ name: "metrics", endpoint: "https://metrics.example" })], logExporters: [backend()] }),
    ],
    ["NodeAgent", () => Object.values(NodeAgent({ exporters: [backend()], metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })], clusterName: "c" }).members) as Declarable[]],
  ];

  test.each(configs)("%s reports none", (_name, entities) => {
    const config = load(collectorYaml(entities())) as CollectorConfig;
    expect(validateCollectorConfig(config).filter((i) => HYGIENE.includes(i.code))).toEqual([]);
  });
});
