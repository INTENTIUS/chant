import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { TelemetryAttribution } from "@intentius/chant/telemetry-attribution";
import { otel118 } from "./otel118";
import { collectorConfigDiagnostics } from "./otel-helpers";
import { isProtectedResourceAttribute, PROTECTED_RESOURCE_ATTRIBUTES } from "../../attribution";
import type { Declarable } from "@intentius/chant/declarable";
import { NodeAgent } from "../../composites";
import { OtlpExporter } from "../../components/exporters";
import { collectorYaml } from "../../collector";
import { genAiPipeline } from "../../genai";

/** A collector with one processor in a traces pipeline. */
function withProcessor(id: string, body: unknown): Record<string, unknown> {
  return {
    receivers: { otlp: { protocols: { grpc: {} } } },
    processors: { [id]: body },
    exporters: { debug: {} },
    service: { pipelines: { traces: { receivers: ["otlp"], processors: [id], exporters: ["debug"] } } },
  };
}

function ctxOf(config: unknown, telemetry: TelemetryAttribution | null = { workspace: "acme" }, lexicon = "otel"): PostSynthContext {
  const ctx = makePostSynthCtx(lexicon, dump(config, { lineWidth: -1 }));
  return telemetry ? { ...ctx, telemetry } : ctx;
}

const run = (config: unknown, telemetry?: TelemetryAttribution | null) => otel118.check(ctxOf(config, telemetry));
const messages = (config: unknown) => run(config).map((d) => d.message);

describe("OTEL118 protected keys", () => {
  test("come from TELEMETRY_ATTRIBUTES, plus any chant.* key", () => {
    expect(PROTECTED_RESOURCE_ATTRIBUTES).toEqual([
      "service.name",
      "service.version",
      "deployment.environment.name",
      "vcs.ref.head.revision",
      "chant.workspace",
      "chant.member",
      "chant.decl",
    ]);
    expect(isProtectedResourceAttribute("chant.team")).toBe(true);
    expect(isProtectedResourceAttribute("service.namespace")).toBe(false);
    expect(isProtectedResourceAttribute("chantx")).toBe(false);
  });
});

describe("OTEL118 gate", () => {
  const upsert = withProcessor("resource", { attributes: [{ key: "service.name", value: "x", action: "upsert" }] });

  test("a build outside a workspace without telemetry.attribution gets no diagnostics", () => {
    expect(otel118.check(ctxOf(upsert, null))).toEqual([]);
    expect(collectorConfigDiagnostics(ctxOf(upsert, null))).toEqual([]);
  });

  test("a build with telemetry.attribution: true outside a workspace is checked", () => {
    expect(run(upsert, {})).toHaveLength(1);
  });

  test("reports a warning naming the processor and its pipelines", () => {
    const [d] = run(upsert);
    expect(d).toMatchObject({ checkId: "OTEL118", severity: "warning", entity: "resource", lexicon: "otel" });
    expect(d.message).toMatch(/^processor "resource" \(pipelines traces\): its upsert action replaces "service\.name"\. /);
  });

  test("a processor no pipeline lists is not checked", () => {
    const config = { ...upsert, service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } } } };
    expect(run(config)).toEqual([]);
  });

  test("WK8604's entry point reports it for a config in a ConfigMap", () => {
    const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "otel-agent-config", namespace: "observability" }, data: { "config.yaml": dump(upsert) } };
    const diags = collectorConfigDiagnostics(ctxOf(configMap, { workspace: "acme" }, "k8s"), { configMapsOnly: true }).filter((d) => d.checkId === "OTEL118");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/^ConfigMap observability\/otel-agent-config, key config\.yaml: processor "resource"/);
    expect(collectorConfigDiagnostics(ctxOf(configMap, null, "k8s"), { configMapsOnly: true })).toEqual([]);
  });
});

describe("OTEL118 resource processor", () => {
  test.each(["delete", "update", "upsert", "hash"])("%s on a protected key is reported", (action) => {
    expect(messages(withProcessor("resource/x", { attributes: [{ key: "deployment.environment.name", value: "prod", action }] }))).toHaveLength(1);
  });

  test("a chant.* key is protected", () => {
    expect(messages(withProcessor("resource", { attributes: [{ key: "chant.team", action: "delete" }] }))[0]).toContain('its delete action removes "chant.team"');
  });

  test("a delete pattern that matches a protected key is reported", () => {
    expect(messages(withProcessor("resource", { attributes: [{ pattern: "^chant\\..*", action: "delete" }] }))[0]).toContain(
      'pattern "^chant\\..*" matches "chant.workspace", "chant.member", "chant.decl"',
    );
  });

  test("insert, extract and unrelated keys pass", () => {
    expect(
      run(
        withProcessor("resource", {
          attributes: [
            { key: "service.name", value: "x", action: "insert" },
            { key: "service.name", pattern: "^(?P<svc>.*)$", action: "extract" },
            { key: "k8s.cluster.name", value: "prod", action: "upsert" },
            { key: "service.namespace", action: "delete" },
            { pattern: "^k8s\\.", action: "delete" },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("OTEL118 transform processor", () => {
  const transform = (trace_statements: unknown[]) => withProcessor("transform/attrs", { trace_statements });

  test("set on a protected key in the resource context, and on resource.attributes from another", () => {
    const msgs = messages(
      transform([
        { context: "resource", statements: ['set(attributes["service.version"], "1")'] },
        { context: "span", statements: ['set(resource.attributes["vcs.ref.head.revision"], "abc")'] },
      ]),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('the OTTL text `set(attributes["service.version"], "1")` matches a call where set replaces "service.version"');
    expect(msgs[1]).toContain('set replaces "vcs.ref.head.revision"');
  });

  test("delete_key and delete_matching_keys", () => {
    const msgs = messages(
      transform([
        'delete_key(resource.attributes, "chant.decl")',
        { context: "resource", statements: ['delete_matching_keys(attributes, "^service\\\\..*")'] },
      ]),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('delete_key removes "chant.decl"');
    expect(msgs[1]).toContain('removes "service.name", "service.version"');
  });

  test("keep_keys and keep_matching_keys that leave a protected key out", () => {
    const msgs = messages(
      transform([
        { context: "resource", statements: ['keep_keys(attributes, ["service.name", "k8s.pod.name"])'] },
        'keep_matching_keys(resource.attributes, "^(service|deployment)\\\\.")',
      ]),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('keep_keys drops "service.version", "deployment.environment.name", "vcs.ref.head.revision", "chant.workspace", "chant.member", "chant.decl"');
    expect(msgs[1]).toContain('drops "vcs.ref.head.revision", "chant.workspace", "chant.member", "chant.decl"');
  });

  test("keep_keys that keeps every protected key passes", () => {
    const keep = `keep_keys(resource.attributes, [${PROTECTED_RESOURCE_ATTRIBUTES.map((k) => `"${k}"`).join(", ")}])`;
    expect(run(transform([keep]))).toEqual([]);
  });

  test("span attributes, unrelated keys and other functions pass", () => {
    expect(
      run(
        transform([
          'set(attributes["service.name"], "x")',
          { context: "span", statements: ['delete_key(attributes, "service.name")', 'set(attributes["chant.decl"], "x")'] },
          { context: "resource", statements: ['set(attributes["k8s.cluster.name"], "prod")', 'delete_key(attributes, "host.name")', 'replace_pattern(attributes["service.name"], "a", "b")'] },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("OTEL118 resourcedetection processor", () => {
  test("override defaults to true, and detectors to [env], at contrib v0.130.0", () => {
    expect(messages(withProcessor("resourcedetection", {}))[0]).toContain("with override on by default, the env detector writes any key in the collector's own OTEL_RESOURCE_ATTRIBUTES");
    expect(messages(withProcessor("resourcedetection", { detectors: ["env", "system"] }))).toHaveLength(1);
  });

  test("override: true with a detector that writes a protected key", () => {
    const msgs = messages(withProcessor("resourcedetection", { detectors: ["env", "heroku", "elastic_beanstalk", "gcp"], override: true }));
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toContain('with override: true, the heroku detector writes "service.name" and "service.version"');
  });

  test("the renamed type resource_detection is read as resourcedetection", () => {
    expect(messages(withProcessor("resource_detection/env", { detectors: ["env"] }))[0]).toMatch(/^processor "resource_detection\/env" .*the env detector/);
  });

  test("override: false, or detectors that write no protected key, pass", () => {
    expect(run(withProcessor("resourcedetection", { detectors: ["env"], override: false }))).toEqual([]);
    expect(run(withProcessor("resourcedetection", { detectors: ["system", "gcp", "k8snode"] }))).toEqual([]);
  });
});

describe("OTEL118 groupbyattrs processor", () => {
  test("a protected key in keys is reported; other keys pass", () => {
    expect(messages(withProcessor("groupbyattrs", { keys: ["host.name", "service.name"] }))[0]).toContain(
      'it groups by "service.name", so a record attribute with that key is copied over the resource\'s value',
    );
    expect(run(withProcessor("groupbyattrs", { keys: ["host.name"] }))).toEqual([]);
  });
});

describe("OTEL118 redaction processor", () => {
  test("allow_all_keys off, its default, deletes protected keys not allowed or ignored", () => {
    const msgs = messages(withProcessor("redaction", { allowed_keys: ["service.name", "service.version"], ignored_keys: ["chant.decl"] }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(
      'with allow_all_keys off by default, it deletes resource keys missing from allowed_keys and ignored_keys: "deployment.environment.name", "vcs.ref.head.revision", "chant.workspace", "chant.member"',
    );
  });

  test("a blocked key pattern matching a protected key masks it unless ignored", () => {
    const msgs = messages(withProcessor("redaction", { allow_all_keys: true, blocked_key_patterns: ["^service\\."], ignored_keys: ["service.version"] }));
    expect(msgs).toEqual([expect.stringContaining('its blocked_key_patterns entry "^service\\." masks the value of "service.name"')]);
  });

  test("allow_all_keys with unrelated patterns passes", () => {
    expect(run(withProcessor("redaction", { allow_all_keys: true, blocked_key_patterns: ["^gen_ai\\.input"], blocked_values: ["\\d{16}"] }))).toEqual([]);
  });
});

describe("OTEL118 sumologic processor", () => {
  test("translate_attributes is on by default and renames service.name", () => {
    expect(messages(withProcessor("sumologic", {}))[0]).toContain('translate_attributes (on by default) renames "service.name" to "service"');
    expect(run(withProcessor("sumologic", { translate_attributes: false }))).toEqual([]);
  });

  test("nest_attributes and aggregate_attributes over protected keys", () => {
    const msgs = messages(
      withProcessor("sumologic", {
        translate_attributes: false,
        nest_attributes: { enabled: true, include: ["chant."], exclude: ["chant.decl"] },
        aggregate_attributes: [{ attribute: "svc", prefixes: ["service."] }, { attribute: "k8s", prefixes: ["k8s.pod."] }],
      }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('nest_attributes turns "chant.workspace", "chant.member" into nested maps');
    expect(msgs[1]).toContain('move "service.name", "service.version"');
  });
});

describe("OTEL118 schema processor", () => {
  test("a target below 1.29.0 reverts vcs.ref.head.revision, below 1.27.0 deployment.environment.name too", () => {
    expect(messages(withProcessor("schema", { targets: ["https://opentelemetry.io/schemas/1.28.0"] }))).toEqual([
      expect.stringContaining('renames "vcs.ref.head.revision" back to "vcs.repository.ref.revision"'),
    ]);
    expect(messages(withProcessor("schema", { targets: ["https://opentelemetry.io/schemas/1.26.0"] }))).toHaveLength(2);
  });

  test("a target at 1.29.0 or later, or another family, passes", () => {
    expect(run(withProcessor("schema", { targets: ["https://opentelemetry.io/schemas/1.29.0", "https://example.com/schemas/1.0.0"] }))).toEqual([]);
  });
});

describe("OTEL118 metricstransform processor", () => {
  test("group_resource_labels setting a protected key is reported", () => {
    const transforms = [
      { include: "^x", match_type: "regexp", action: "group", group_resource_labels: { "deployment.environment.name": "prod", team: "a" } },
      { include: "y", action: "update", new_name: "z" },
    ];
    expect(messages(withProcessor("metricstransform", { transforms }))[0]).toContain('group_resource_labels sets "deployment.environment.name"');
    expect(run(withProcessor("metricstransform", { transforms: [{ include: "^x", action: "group", group_resource_labels: { team: "a" } }] }))).toEqual([]);
  });
});

describe("OTEL118 logstransform processor", () => {
  test("operators on protected resource fields, a narrowing retain, and parse_to: resource", () => {
    const msgs = messages(
      withProcessor("logstransform", {
        operators: [
          { type: "remove", field: 'resource["chant.member"]' },
          { type: "move", from: 'attributes["svc"]', to: 'resource["service.name"]' },
          { type: "retain", fields: ['resource["service.name"]'] },
          { type: "json_parser", parse_to: "resource" },
        ],
      }),
    );
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toContain('its remove operator writes or removes "chant.member"');
    expect(msgs[2]).toContain("its retain operator keeps only the resource fields it lists");
  });

  test("operators on other fields pass", () => {
    const operators = [
      { type: "add", field: 'resource["team"]', value: "a" },
      { type: "retain", fields: ['attributes["x"]'] },
      { type: "json_parser", parse_to: "attributes" },
    ];
    expect(run(withProcessor("logstransform", { operators }))).toEqual([]);
  });
});

describe("OTEL118 processors that don't replace resource keys", () => {
  test("attributes acts on span, log and metric attributes", () => {
    expect(run(withProcessor("attributes", { actions: [{ key: "service.name", action: "delete" }] }))).toEqual([]);
  });

  test("k8sattributes only fills service.name and service.version where they are absent", () => {
    expect(run(withProcessor("k8sattributes", { extract: { metadata: ["service.name", "service.version"], otel_annotations: true } }))).toEqual([]);
  });

  test("NodeAgent, with every option on, and genAiPipeline report nothing", () => {
    const gateway = new OtlpExporter({ name: "gateway", endpoint: "gw:4317", tls: { insecure: true } });
    const agent = NodeAgent({ exporters: [gateway], clusterName: "prod", kubeletStats: true });
    for (const yaml of [collectorYaml(Object.values(agent.members) as Declarable[]), collectorYaml(genAiPipeline())]) {
      expect(otel118.check({ ...makePostSynthCtx("otel", yaml), telemetry: { workspace: "acme" } })).toEqual([]);
    }
  });
});
