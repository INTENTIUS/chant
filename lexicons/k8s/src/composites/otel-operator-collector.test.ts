/**
 * OtelOperatorCollector (#3367): the OpenTelemetryCollector custom resource
 * built from otel entities, and the checks that read it: WK8604 over
 * `spec.config`, WK8601, WK8602, WK8603 and WK8605 over `spec.mode`,
 * `spec.replicas`, `spec.env` and `spec.volumeMounts`.
 */
import { describe, expect, test } from "vitest";
import { dump, loadAll } from "js-yaml";
import { expandComposite } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import {
  DebugExporter,
  FileLogReceiver,
  K8sAttributesProcessor,
  K8sClusterReceiver,
  LoadBalancingExporter,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  TailSamplingProcessor,
  collectorConfig,
  defineComponent,
  type CollectorConfig,
} from "@intentius/chant-lexicon-otel";
import { k8sSerializer } from "../serializer";
import { OtelOperatorCollector } from "./otel-operator-collector";
import { OtelCollector } from "./otel-collector";
import { OTEL_COLLECTOR_ANNOTATIONS as A } from "./otel-collector-shape";
import { collectorPlacements } from "../lint/post-synth/otel-placement-helpers";
import { docsToManifests } from "../lint/post-synth/k8s-helpers";
import { wk8601 } from "../lint/post-synth/wk8601";
import { wk8602 } from "../lint/post-synth/wk8602";
import { wk8603 } from "../lint/post-synth/wk8603";
import { wk8604 } from "../lint/post-synth/wk8604";
import { wk8605 } from "../lint/post-synth/wk8605";

function p(member: unknown): any {
  return (member as { props: unknown }).props;
}

function built(instances: Record<string, unknown>): PostSynthContext {
  const entities = new Map<string, Declarable>();
  for (const [name, instance] of Object.entries(instances)) {
    for (const [k, v] of expandComposite(name, instance as never)) entities.set(k, v);
  }
  const out = k8sSerializer.serialize(entities);
  return makePostSynthCtx("k8s", typeof out === "string" ? out : out.primary);
}

/** Hand-written manifests as a multi-document stream. */
const yaml = (...docs: object[]) => makePostSynthCtx("k8s", docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n"));

const otlp = () => new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
const tail = () =>
  new TailSamplingProcessor({
    decision_wait: "5s",
    policies: [{ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } }],
  });
const tracesTo = (...processors: Declarable[]) => [
  new Pipeline({ signal: "traces", receivers: [otlp()], processors: processors as never, exporters: [new DebugExporter({})] }),
];

function cr(name: string, spec: Record<string, unknown>, namespace = "obs"): object {
  return { apiVersion: "opentelemetry.io/v1beta1", kind: "OpenTelemetryCollector", metadata: { name, namespace }, spec };
}

const PLAIN: CollectorConfig = {
  receivers: { otlp: { protocols: { grpc: {} } } },
  exporters: { debug: {} },
  service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } } },
};

describe("OtelOperatorCollector", () => {
  test("returns an OpenTelemetryCollector, a ServiceAccount, a ClusterRole and a ClusterRoleBinding", () => {
    const c = OtelOperatorCollector({});
    for (const key of ["collector", "serviceAccount", "clusterRole", "clusterRoleBinding"]) expect((c as any)[key], key).toBeDefined();
    expect((c as any).configMap).toBeUndefined();
    expect((c as any).daemonSet).toBeUndefined();
  });

  test("sets spec.config to the built config, an object, and spec.mode to the agent shape by default", () => {
    const entities = tracesTo();
    const c = OtelOperatorCollector({ config: entities });
    const spec = p(c.collector).spec;
    expect(spec.mode).toBe("daemonset");
    expect(spec.config).toEqual(collectorConfig(entities));
    expect(typeof spec.config).toBe("object");
    expect(spec.serviceAccount).toBe("otel-collector-sa");
    expect(p(c.collector).metadata).toMatchObject({ name: "otel-collector", namespace: "observability" });
  });

  test("renders opentelemetry.io/v1beta1 with the config as a YAML map", () => {
    const docs = loadAll(
      (() => {
        const out = k8sSerializer.serialize(new Map(expandComposite("c", OtelOperatorCollector({ config: tracesTo() }) as never)));
        return typeof out === "string" ? out : out.primary;
      })(),
    ) as Array<Record<string, any>>;
    const doc = docs.find((d) => d.kind === "OpenTelemetryCollector")!;
    expect(doc.apiVersion).toBe("opentelemetry.io/v1beta1");
    expect(doc.spec.config.service.pipelines.traces.exporters).toEqual(["debug"]);
    expect(doc.spec.config.receivers.otlp.protocols.grpc.endpoint).toBe("0.0.0.0:4317");
  });

  test("a deployment takes replicas; a daemonset refuses them", () => {
    const d = OtelOperatorCollector({ mode: "deployment", replicas: 3 });
    expect(p(d.collector).spec).toMatchObject({ mode: "deployment", replicas: 3 });
    expect(p(d.collector).spec.tolerations).toBeUndefined();
    expect(() => OtelOperatorCollector({ mode: "daemonset", replicas: 2 })).toThrow(/replicas does not apply/);
    expect(p(OtelOperatorCollector({}).collector).spec.replicas).toBeUndefined();
  });

  test("ports are read back from the config, and the RBAC matches OtelCollector's", () => {
    const config = [new Pipeline({ signal: "traces", receivers: [otlp()], processors: [new K8sAttributesProcessor({})], exporters: [new DebugExporter({})] })];
    const c = OtelOperatorCollector({ config });
    const agent = OtelCollector({ config });
    expect(p(c.collector).spec.ports).toEqual([{ name: "otlp-grpc", port: 4317, protocol: "TCP" }]);
    expect(p(c.clusterRole).rules).toEqual(p(agent.clusterRole).rules);
    expect(p(c.clusterRoleBinding).subjects).toEqual([{ kind: "ServiceAccount", name: "otel-collector-sa", namespace: "observability" }]);
  });

  test("node access goes in spec.env, spec.volumes and spec.volumeMounts, and log group in spec.podSecurityContext", () => {
    const config = [
      new Pipeline({
        signal: "logs",
        receivers: [new FileLogReceiver({ include: ["/var/log/pods/*/*/*.log"] })],
        processors: [new K8sAttributesProcessor({ filter: { node_from_env_var: "K8S_NODE_NAME" } })],
        exporters: [new DebugExporter({})],
      }),
    ];
    const spec = p(OtelOperatorCollector({ config }).collector).spec;
    expect(spec.env).toEqual([{ name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } }]);
    expect(spec.volumes.map((v: any) => v.hostPath.path)).toContain("/var/log/pods");
    expect(spec.volumeMounts.every((m: any) => m.readOnly === true)).toBe(true);
    expect(spec.podSecurityContext).toEqual({ supplementalGroups: [0] });

    const root = p(OtelOperatorCollector({ config, logAccess: "root" }).collector).spec;
    expect(root.podSecurityContext).toBeUndefined();
    expect(root.securityContext).toMatchObject({ runAsUser: 0, runAsNonRoot: false });
  });

  test("the # chant: header lines go in the otel.chant.dev/header annotation, one per line", () => {
    const Mycorp = defineComponent<{ endpoint: string }>()({
      kind: "receiver",
      type: "mycorp",
      pin: { source: "github.com/mycorp/otel", version: "v1.2.3" },
    });
    const config = [new Pipeline({ signal: "traces", receivers: [new Mycorp({ endpoint: "0.0.0.0:9999" })], exporters: [new DebugExporter({})] })];
    const header = p(OtelOperatorCollector({ config }).collector).metadata.annotations[A.header] as string;
    expect(header).toBe("chant: receiver mycorp schema github.com/mycorp/otel@v1.2.3");
    // A config with no pins writes no annotation.
    expect(p(OtelOperatorCollector({ config: tracesTo() }).collector).metadata.annotations[A.header]).toBeUndefined();
  });
});

describe("WK8604 over an OpenTelemetryCollector's spec.config", () => {
  test("passes what OtelOperatorCollector renders", () => {
    expect(wk8604.check(built({ agent: OtelOperatorCollector({ config: tracesTo() }) }))).toEqual([]);
    expect(wk8604.check(built({ gw: OtelOperatorCollector({ mode: "deployment", replicas: 2 }) }))).toEqual([]);
  });

  test("reports an undeclared exporter under OTEL101, naming the custom resource", () => {
    const broken = { ...PLAIN, service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug", "otlp/tempo"] } } } };
    const diags = wk8604.check(yaml(cr("agent", { mode: "daemonset", config: broken })));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "OTEL101", severity: "error", lexicon: "otel" });
    expect(diags[0].message).toMatch(/^OpenTelemetryCollector obs\/agent, spec\.config: /);
    expect(diags[0].message).toContain("otlp/tempo");
  });

  test("reads a v1alpha1 CR's config text", () => {
    const text = dump({ ...PLAIN, service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["nope"] } } } });
    const doc = { apiVersion: "opentelemetry.io/v1alpha1", kind: "OpenTelemetryCollector", metadata: { name: "old" }, spec: { config: text } };
    const diags = wk8604.check(yaml(doc));
    expect(diags.map((d) => d.checkId)).toEqual(["OTEL101"]);
    expect(diags[0].message).toMatch(/^OpenTelemetryCollector default\/old, spec\.config: /);
  });

  test("ignores another group's OpenTelemetryCollector and a CR without a pipelines map", () => {
    expect(wk8604.check(yaml({ ...cr("x", { config: { exporters: ["a"] } }) }))).toEqual([]);
    expect(wk8604.check(yaml({ ...(cr("x", { config: PLAIN }) as object), apiVersion: "example.com/v1" }))).toEqual([]);
  });
});

describe("the placement checks over an OpenTelemetryCollector", () => {
  test("a CR is joined as a workload: kind from spec.mode, replicas from spec.replicas, config from spec.config", () => {
    const manifests = docsToManifests(
      yaml(
        cr("a", { mode: "daemonset", config: PLAIN }),
        cr("b", { replicas: 4, config: PLAIN }),
        cr("c", { mode: "statefulset", config: PLAIN, autoscaler: { maxReplicas: 6 } }),
        cr("d", { mode: "sidecar", config: PLAIN }),
      ),
    );
    const placements = collectorPlacements(manifests).map((x) => [x.name, x.kind, x.replicas, x.key]);
    expect(placements).toEqual([
      ["a", "DaemonSet", undefined, "spec.config"],
      ["b", "Deployment", 4, "spec.config"],
      ["c", "StatefulSet", 6, "spec.config"],
    ]);
  });

  test("WK8601 reports tail_sampling in a daemonset CR, and not in a deployment CR", () => {
    const agent = wk8601.check(built({ agent: OtelOperatorCollector({ config: tracesTo(tail()) }) }));
    expect(agent).toHaveLength(1);
    expect(agent[0].message).toContain("OpenTelemetryCollector observability/otel-collector (mode daemonset)");
    expect(agent[0].message).toContain("spec.config");
    expect(wk8601.check(built({ gw: OtelOperatorCollector({ mode: "deployment", config: tracesTo(tail()) }) }))).toEqual([]);
  });

  test("WK8602 reports a multi-replica gateway CR that a collector sends traces to through its Service without trace-aware routing", () => {
    const gateway = OtelOperatorCollector({ name: "gw", mode: "deployment", replicas: 3, config: tracesTo(tail()) });
    const sender = (exporter: Declarable) =>
      OtelOperatorCollector({
        name: "agent",
        config: [new Pipeline({ signal: "traces", receivers: [otlp()], exporters: [exporter as never] })],
      });

    const direct = wk8602.check(built({ gateway, agent: sender(new OtlpExporter({ endpoint: "gw-collector.observability.svc:4317" })) }));
    expect(direct).toHaveLength(1);
    expect(direct[0].message).toContain("OpenTelemetryCollector observability/gw (mode deployment)");
    expect(direct[0].message).toContain("sends to Service gw-collector.observability directly");

    const balanced = new LoadBalancingExporter({
      routing_key: "traceID",
      protocol: { otlp: { tls: { insecure: true } } },
      resolver: { dns: { hostname: "gw-collector-headless.observability.svc" } },
    });
    expect(wk8602.check(built({ gateway, agent: sender(balanced) }))).toEqual([]);

    const single = OtelOperatorCollector({ name: "gw", mode: "deployment", replicas: 1, config: tracesTo(tail()) });
    expect(wk8602.check(built({ gateway: single, agent: sender(new OtlpExporter({ endpoint: "gw-collector.observability.svc:4317" })) }))).toEqual([]);
  });

  test("WK8603 reports k8s_cluster on a daemonset or multi-replica CR, and not on one replica", () => {
    const config = [new Pipeline({ signal: "metrics", receivers: [new K8sClusterReceiver({})], exporters: [new DebugExporter({})] })];
    expect(wk8603.check(built({ a: OtelOperatorCollector({ config }) }))).toHaveLength(1);
    expect(wk8603.check(built({ a: OtelOperatorCollector({ mode: "deployment", replicas: 2, config }) }))).toHaveLength(1);
    expect(wk8603.check(built({ a: OtelOperatorCollector({ mode: "deployment", replicas: 1, config }) }))).toEqual([]);
  });

  test("WK8605 passes the node access the composite adds, and reports a hand-written CR without it", () => {
    const config = [
      new Pipeline({
        signal: "logs",
        receivers: [new FileLogReceiver({ include: ["/var/log/pods/*/*/*.log"] })],
        processors: [new K8sAttributesProcessor({ filter: { node_from_env_var: "K8S_NODE_NAME" } })],
        exporters: [new DebugExporter({})],
      }),
    ];
    expect(wk8605.check(built({ a: OtelOperatorCollector({ config }) }))).toEqual([]);

    const bare = collectorConfig(config);
    const diags = wk8605.check(yaml(cr("bare", { mode: "daemonset", config: bare })));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("no K8S_NODE_NAME variable");
    expect(diags[0].message).toContain("/var/log/pods");
  });
});

describe("annotation keys", () => {
  test("header is one of OTEL_COLLECTOR_ANNOTATIONS", () => {
    expect(A.header).toBe("otel.chant.dev/header");
  });
});
