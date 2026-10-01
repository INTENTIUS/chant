/**
 * WK8601, WK8602 and WK8603: where a collector config runs (chant #2899).
 *
 * Two kinds of fixture. Composite-built ones go through `OtelCollector`,
 * `OtelCollectorGateway` and the k8s serializer, so they join through the
 * `otel.chant.dev/*` annotations. Hand-written YAML has no annotations and
 * joins through the workload's ConfigMap volumes, the way `GkeOtelCollector`
 * and plain manifests do.
 */
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { expandComposite } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import {
  DebugExporter,
  K8sClusterReceiver,
  OtlpReceiver,
  Pipeline,
  TailSamplingProcessor,
} from "@intentius/chant-lexicon-otel";
import { k8sSerializer } from "../../serializer";
import { OtelCollector } from "../../composites/otel-collector";
import { OtelCollectorGateway, gatewayExporter } from "../../composites/otel-collector-gateway";
import { GkeOtelCollector } from "../../composites/gke-otel-collector";
import { OTEL_COLLECTOR_ANNOTATIONS } from "../../composites/otel-collector-shape";
import { PLACEMENT_ANNOTATIONS, collectorPlacements, hostOfEndpoint, serviceOfHost } from "./otel-placement-helpers";
import { docsToManifests } from "./k8s-helpers";
import { wk8601 } from "./wk8601";
import { wk8602 } from "./wk8602";
import { wk8603 } from "./wk8603";
import { wk8604 } from "./wk8604";

// ── Fixture builders ────────────────────────────────────────────────

function built(instances: Record<string, unknown>): PostSynthContext {
  const entities = new Map<string, Declarable>();
  for (const [name, instance] of Object.entries(instances)) {
    for (const [k, v] of expandComposite(name, instance as never)) entities.set(k, v);
  }
  const out = k8sSerializer.serialize(entities);
  return makePostSynthCtx("k8s", typeof out === "string" ? out : out.primary);
}

const otlp = () => new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
const tail = () =>
  new TailSamplingProcessor({
    decision_wait: "5s",
    policies: [{ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } }],
  });

function samplingGateway(replicas: number) {
  return OtelCollectorGateway({
    replicas,
    config: [new Pipeline({ signal: "traces", receivers: [otlp()], processors: [tail()], exporters: [new DebugExporter({})] })],
  });
}

function agentSending(traces: ReturnType<typeof gatewayExporter>, metrics?: ReturnType<typeof gatewayExporter>) {
  const rx = otlp();
  return OtelCollector({
    name: "agent",
    config: [
      new Pipeline({ signal: "traces", receivers: [rx], exporters: [traces] }),
      ...(metrics ? [new Pipeline({ signal: "metrics", receivers: [rx], exporters: [metrics] })] : []),
    ],
  });
}

/** A ConfigMap holding collector configs under the given keys. */
function configMap(name: string, data: Record<string, string>, namespace = "obs"): object {
  return { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace }, data };
}

/** A plain collector workload mounting one ConfigMap, with no chant annotations. */
function workload(opts: { kind: string; name: string; configMap: string; replicas?: number; args?: string[] }): object {
  return {
    apiVersion: "apps/v1",
    kind: opts.kind,
    metadata: { name: opts.name, namespace: "obs" },
    spec: {
      ...(opts.replicas === undefined ? {} : { replicas: opts.replicas }),
      selector: { matchLabels: { app: opts.name } },
      template: {
        metadata: { labels: { app: opts.name } },
        spec: {
          containers: [
            {
              name: "otelcol",
              image: "otel/opentelemetry-collector-contrib:0.130.0",
              ...(opts.args ? { args: opts.args } : {}),
              volumeMounts: [{ name: "conf", mountPath: "/conf" }],
            },
          ],
          volumes: [{ name: "conf", configMap: { name: opts.configMap } }],
        },
      },
    },
  };
}

function service(name: string, app: string, headless = false): object {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: "obs" },
    spec: { ...(headless ? { clusterIP: "None" } : {}), selector: { app }, ports: [{ name: "otlp-grpc", port: 4317 }] },
  };
}

function hpa(name: string, maxReplicas: number): object {
  return {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name, namespace: "obs" },
    spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name }, minReplicas: 1, maxReplicas },
  };
}

/** Serialize hand-written manifests as a multi-document stream, the way a build emits them. */
const yaml = (...docs: object[]) => makePostSynthCtx("k8s", docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n"));

const TAIL_CONFIG = `
receivers: { otlp: { protocols: { grpc: {} } } }
processors:
  tail_sampling:
    policies: [{ name: errors, type: status_code, status_code: { status_codes: [ERROR] } }]
exporters: { debug: {} }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [tail_sampling], exporters: [debug] }
`;

const PLAIN_CONFIG = `
receivers: { otlp: { protocols: { grpc: {} } } }
exporters: { debug: {} }
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [debug] }
`;

/** An agent config whose traces exporter is given as YAML. */
function agentConfig(exporterId: string, exporter: string): string {
  return `
receivers: { otlp: { protocols: { grpc: {} } } }
exporters:
  ${exporterId}: ${exporter}
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [${exporterId}] }
`;
}

/** A 3-replica gateway running tail_sampling, with a ClusterIP and a headless Service. */
const GATEWAY = [
  configMap("gw-config", { "config.yaml": TAIL_CONFIG }),
  workload({ kind: "Deployment", name: "gw", configMap: "gw-config", replicas: 3 }),
  service("gw", "gw"),
  service("gw-headless", "gw", true),
];

function withAgent(exporterId: string, exporter: string, gateway = GATEWAY): PostSynthContext {
  return yaml(
    ...gateway,
    configMap("agent-config", { "config.yaml": agentConfig(exporterId, exporter) }),
    workload({ kind: "DaemonSet", name: "agent", configMap: "agent-config" }),
  );
}

// ── The join ────────────────────────────────────────────────────────

describe("collectorPlacements", () => {
  test("uses the same annotation keys the composites write", () => {
    expect(PLACEMENT_ANNOTATIONS).toEqual(OTEL_COLLECTOR_ANNOTATIONS);
  });

  test("joins composite output through the annotations, with replicas", () => {
    const ctx = built({ gateway: samplingGateway(3), agent: agentSending(gatewayExporter(samplingGateway(3), { loadBalance: true })) });
    const shapes = collectorPlacements(docsToManifests(ctx)).map((p) => [p.kind, p.name, p.replicas, p.configMap, p.key]);
    expect(shapes).toEqual(
      expect.arrayContaining([
        ["Deployment", "otel-gateway", 3, "otel-gateway-config", "config.yaml"],
        ["DaemonSet", "agent", undefined, "agent-config", "config.yaml"],
      ]),
    );
  });

  test("joins plain manifests through ConfigMap volumes, skipping data that isn't a collector config", () => {
    const ctx = yaml(
      configMap("mixed", { "config.yaml": TAIL_CONFIG, "notes.yaml": "a: 1\n" }),
      workload({ kind: "DaemonSet", name: "agent", configMap: "mixed" }),
    );
    expect(collectorPlacements(docsToManifests(ctx)).map((p) => p.key)).toEqual(["config.yaml"]);
  });

  test("a --config argument picks the key when a ConfigMap holds several configs", () => {
    const docs = (arg: string) =>
      docsToManifests(
        yaml(
          configMap("both", { "agent.yaml": PLAIN_CONFIG, "gateway.yaml": TAIL_CONFIG }),
          workload({ kind: "DaemonSet", name: "agent", configMap: "both", args: [`--config=/conf/${arg}`] }),
        ),
      );
    expect(collectorPlacements(docs("agent.yaml")).map((p) => p.key)).toEqual(["agent.yaml"]);
    expect(collectorPlacements(docs("gateway.yaml")).map((p) => p.key)).toEqual(["gateway.yaml"]);
  });

  test("an HPA raises the replica count to its maxReplicas", () => {
    const ctx = yaml(configMap("gw-config", { "config.yaml": TAIL_CONFIG }), workload({ kind: "Deployment", name: "gw", configMap: "gw-config" }), hpa("gw", 4));
    expect(collectorPlacements(docsToManifests(ctx))[0].replicas).toBe(4);
  });

  test("reads cluster DNS names and endpoints", () => {
    expect(serviceOfHost("gw", "obs")).toBe("gw.obs");
    expect(serviceOfHost("gw.obs", "x")).toBe("gw.obs");
    expect(serviceOfHost("gw.obs.svc.cluster.local", "x")).toBe("gw.obs");
    expect(serviceOfHost("collector.example.com", "x")).toBeUndefined();
    expect(hostOfEndpoint("gw.obs.svc:4317")).toBe("gw.obs.svc");
    expect(hostOfEndpoint("http://gw.obs.svc:4318/v1/traces")).toBe("gw.obs.svc");
    expect(hostOfEndpoint("dns:///gw.obs.svc:4317")).toBe("gw.obs.svc");
  });
});

// ── WK8601 ──────────────────────────────────────────────────────────

describe("WK8601: tail_sampling in a per-node collector", () => {
  test("flags an OtelCollector agent running tail_sampling", () => {
    const agent = OtelCollector({
      name: "agent",
      config: [new Pipeline({ signal: "traces", receivers: [otlp()], processors: [tail()], exporters: [new DebugExporter({})] })],
    });
    const diags = wk8601.check(built({ agent }));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "WK8601", severity: "warning", entity: "agent", lexicon: "k8s" });
    expect(diags[0].message).toContain("DaemonSet observability/agent runs tail_sampling");
  });

  test("flags a hand-written DaemonSet mounting a tail sampling config", () => {
    const diags = wk8601.check(yaml(configMap("c", { "config.yaml": TAIL_CONFIG }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" })));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("DaemonSet obs/agent");
  });

  test("passes tail_sampling on a gateway Deployment", () => {
    expect(wk8601.check(built({ gateway: samplingGateway(2) }))).toEqual([]);
  });

  test("passes a declared tail_sampling no pipeline runs", () => {
    const unused = TAIL_CONFIG.replace("processors: [tail_sampling], ", "");
    expect(wk8601.check(yaml(configMap("c", { "config.yaml": unused }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" })))).toEqual([]);
  });

  test("stays silent when the ConfigMap is not in the build", () => {
    expect(wk8601.check(yaml(workload({ kind: "DaemonSet", name: "agent", configMap: "elsewhere" })))).toEqual([]);
  });

  test("passes GkeOtelCollector, which carries no annotations", () => {
    const gke = GkeOtelCollector({ clusterName: "c", projectId: "p", gcpServiceAccountEmail: "o@p.iam.gserviceaccount.com" });
    const ctx = built({ gke });
    expect(collectorPlacements(docsToManifests(ctx)).map((p) => p.kind)).toEqual(["DaemonSet"]);
    for (const check of [wk8601, wk8602, wk8603]) expect(check.check(ctx)).toEqual([]);
  });
});

// ── WK8602 ──────────────────────────────────────────────────────────

describe("WK8602: multi-replica tail sampling gateway without trace-aware routing", () => {
  test("flags agents sending traces to the gateway's ClusterIP Service", () => {
    const gateway = samplingGateway(3);
    const diags = wk8602.check(built({ gateway, agent: agentSending(gatewayExporter(gateway)) }));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "WK8602", severity: "warning", entity: "otel-gateway" });
    expect(diags[0].message).toContain("otlp/gateway sends to Service otel-gateway.observability directly");
  });

  test("passes agents that route traces by traceID through loadbalancing", () => {
    const gateway = samplingGateway(3);
    const ctx = built({ gateway, agent: agentSending(gatewayExporter(gateway, { loadBalance: true })) });
    for (const check of [wk8601, wk8602, wk8603]) expect(check.check(ctx)).toEqual([]);
  });

  test("passes metrics sent to the Service when traces go through loadbalancing", () => {
    const gateway = samplingGateway(3);
    const agent = agentSending(gatewayExporter(gateway, { loadBalance: true }), gatewayExporter(gateway, { name: "metrics" }));
    expect(wk8602.check(built({ gateway, agent }))).toEqual([]);
  });

  test("passes a single-replica gateway reached through its Service", () => {
    const gateway = samplingGateway(1);
    expect(wk8602.check(built({ gateway, agent: agentSending(gatewayExporter(gateway)) }))).toEqual([]);
  });

  test("flags loadbalancing routed by service rather than traceID", () => {
    const gateway = samplingGateway(2);
    const diags = wk8602.check(built({ gateway, agent: agentSending(gatewayExporter(gateway, { loadBalance: true, routingKey: "service" })) }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("routes by service, not traceID");
  });

  test("flags a hand-written otlp exporter at the ClusterIP Service", () => {
    expect(wk8602.check(withAgent("otlp", "{ endpoint: gw.obs.svc.cluster.local:4317 }"))).toHaveLength(1);
  });

  test("flags a hand-written otlphttp exporter at the Service", () => {
    expect(wk8602.check(withAgent("otlphttp", "{ endpoint: 'http://gw:4318' }"))).toHaveLength(1);
  });

  test("flags the dns resolver on the ClusterIP Service", () => {
    const diags = wk8602.check(withAgent("loadbalancing", "{ protocol: { otlp: {} }, resolver: { dns: { hostname: gw.obs.svc } } }"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("one virtual IP");
  });

  test("passes hand-written loadbalancing through the dns resolver on the headless Service", () => {
    expect(wk8602.check(withAgent("loadbalancing", "{ protocol: { otlp: {} }, resolver: { dns: { hostname: gw-headless.obs.svc } } }"))).toEqual([]);
  });

  test("passes hand-written loadbalancing through the k8s resolver with routing_key traceID", () => {
    expect(wk8602.check(withAgent("loadbalancing", "{ routing_key: traceID, protocol: { otlp: {} }, resolver: { k8s: { service: gw-headless.obs } } }"))).toEqual([]);
  });

  test("flags a gateway scaled past one replica by an HPA", () => {
    const gateway = [configMap("gw-config", { "config.yaml": TAIL_CONFIG }), workload({ kind: "Deployment", name: "gw", configMap: "gw-config", replicas: 1 }), service("gw", "gw"), hpa("gw", 3)];
    expect(wk8602.check(withAgent("otlp", "{ endpoint: gw.obs.svc:4317 }", gateway))).toHaveLength(1);
  });

  test("stays silent with no sender in the build", () => {
    expect(wk8602.check(yaml(...GATEWAY))).toEqual([]);
  });

  test("ignores exporters to somewhere else", () => {
    expect(wk8602.check(withAgent("otlp", "{ endpoint: tempo.tracing.svc:4317 }"))).toEqual([]);
  });
});

// ── WK8603 ──────────────────────────────────────────────────────────

/** A config running k8s_cluster in a metrics pipeline, with the given receiver settings, extensions and service.extensions. */
function clusterConfig(receiver: string, extensions: string, enabled: string): string {
  return `
receivers:
  k8s_cluster: ${receiver}
exporters: { debug: {} }
extensions: ${extensions}
service:
  extensions: ${enabled}
  pipelines:
    metrics: { receivers: [k8s_cluster], exporters: [debug] }
`;
}

const ELECTED = "{ k8s_leader_elector: k8s_leader_elector }";
const LEADER = "{ k8s_leader_elector: { lease_name: otel, lease_namespace: obs } }";

describe("WK8603: k8s_cluster receiver in every collector copy", () => {
  const clusterPipeline = () => new Pipeline({ signal: "metrics", receivers: [new K8sClusterReceiver({})], exporters: [new DebugExporter({})] });

  test("flags an OtelCollector agent running k8s_cluster", () => {
    const diags = wk8603.check(built({ agent: OtelCollector({ name: "agent", config: [clusterPipeline()] }) }));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "WK8603", severity: "warning", entity: "agent" });
    expect(diags[0].message).toContain("on every node");
    expect(diags[0].message).toContain("k8s_cluster has no k8s_leader_elector");
  });

  test("flags a two-replica gateway running k8s_cluster", () => {
    const diags = wk8603.check(built({ gateway: OtelCollectorGateway({ replicas: 2, config: [clusterPipeline()] }) }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("each of up to 2 replicas");
  });

  test("passes a single-replica gateway running k8s_cluster", () => {
    expect(wk8603.check(built({ gateway: OtelCollectorGateway({ replicas: 1, config: [clusterPipeline()] }) }))).toEqual([]);
  });

  test("passes a DaemonSet whose k8s_cluster names an enabled k8s_leader_elector", () => {
    const ctx = yaml(configMap("c", { "config.yaml": clusterConfig(ELECTED, LEADER, "[k8s_leader_elector]") }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" }));
    expect(wk8603.check(ctx)).toEqual([]);
  });

  test("flags a k8s_leader_elector that is declared but not enabled", () => {
    const ctx = yaml(configMap("c", { "config.yaml": clusterConfig(ELECTED, LEADER, "[]") }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" }));
    const diags = wk8603.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("not enabled in service.extensions");
  });

  test("flags a k8s_leader_elector reference to nothing", () => {
    const ctx = yaml(configMap("c", { "config.yaml": clusterConfig(ELECTED, "{}", "[k8s_leader_elector]") }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" }));
    expect(wk8603.check(ctx)[0].message).toContain("not a declared k8s_leader_elector extension");
  });

  test("passes a k8s_cluster receiver no pipeline uses", () => {
    const unused = `
receivers: { k8s_cluster: {}, otlp: { protocols: { grpc: {} } } }
exporters: { debug: {} }
service: { pipelines: { metrics: { receivers: [otlp], exporters: [debug] } } }
`;
    expect(wk8603.check(yaml(configMap("c", { "config.yaml": unused }), workload({ kind: "DaemonSet", name: "agent", configMap: "c" })))).toEqual([]);
  });
});

// ── WK8604 ──────────────────────────────────────────────────────────

describe("WK8604: the otel config checks over ConfigMap configs", () => {
  test("reports an undeclared exporter under OTEL101, naming the ConfigMap and key", () => {
    const broken = PLAIN_CONFIG.replace("exporters: [debug]", "exporters: [debug, otlp/tempo]");
    const diags = wk8604.check(yaml(configMap("agent-config", { "config.yaml": broken })));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "OTEL101", severity: "error", lexicon: "otel" });
    expect(diags[0].message).toMatch(/^ConfigMap obs\/agent-config, key config\.yaml: /);
    expect(diags[0].message).toContain("otlp/tempo");
  });

  test("checks every key that holds a config, defaulting the namespace", () => {
    const unused = PLAIN_CONFIG.replace("exporters: { debug: {} }", "exporters: { debug: {} }\nprocessors: { batch: {} }");
    const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" }, data: { "a.yaml": PLAIN_CONFIG, "b.yaml": unused } };
    const diags = wk8604.check(yaml(cm));
    expect(diags.map((d) => [d.checkId, d.entity])).toEqual([["OTEL103", "batch"]]);
    expect(diags[0].message).toContain("ConfigMap default/c, key b.yaml");
  });

  test("ignores ConfigMap values that are not collector configs", () => {
    const ctx = yaml(configMap("prometheus-config", { "prometheus.yml": "scrape_configs: []\n", "rules.yml": "groups: [ {" }));
    expect(wk8604.check(ctx)).toEqual([]);
  });

  test("passes what OtelCollector, OtelCollectorGateway and GkeOtelCollector render", () => {
    const gke = GkeOtelCollector({ clusterName: "c", projectId: "p", gcpServiceAccountEmail: "o@p.iam.gserviceaccount.com" });
    const gateway = samplingGateway(2);
    const agent = agentSending(gatewayExporter(gateway, { loadBalance: true }));
    expect(wk8604.check(built({ gke, gateway, agent }))).toEqual([]);
  });
});

