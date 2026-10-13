import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { otelSerializer } from "../serializer";
import { collectorYaml } from "../collector";
import { collectorTopology } from "../topology";
import { validateCollectorEntities } from "../validate-config";
import { COLLECTOR_PIN, SEMCONV_PIN } from "../define";
import { DebugExporter } from "./exporters";
import { K8sClusterReceiver, KubeletStatsReceiver } from "./k8s-receivers";
import { Pipeline } from "../pipeline";

function problems(component: Declarable): string[] {
  return validateCollectorEntities([component])
    .filter((i) => i.code === "OTEL107")
    .map((i) => i.message.replace(/^\w+ "[^"]+": /, ""));
}

function primary(out: ReturnType<typeof otelSerializer.serialize>): string {
  return typeof out === "string" ? out : out.primary;
}

describe("k8s_cluster and kubeletstats are built-ins pinned to the collector release", () => {
  test.each([
    [K8sClusterReceiver, "k8s_cluster"],
    [KubeletStatsReceiver, "kubeletstats"],
  ] as const)("%o", (Cls, type) => {
    expect(Cls.definition.kind).toBe("receiver");
    expect(Cls.definition.type).toBe(type);
    expect(Cls.definition.builtin).toBe(true);
    expect(Cls.definition.pin).toBe(COLLECTOR_PIN);
  });
});

describe("k8s_cluster receiver", () => {
  test("serializes", () => {
    const cluster = new K8sClusterReceiver({
      auth_type: "serviceAccount",
      collection_interval: "30s",
      node_conditions_to_report: ["Ready", "MemoryPressure"],
      allocatable_types_to_report: ["cpu", "memory"],
      k8s_leader_elector: "k8s_leader_elector",
      metrics: { "k8s.pod.status_reason": { enabled: true } },
    });
    const out = primary(otelSerializer.serialize(new Map([["cluster", cluster as unknown as Declarable]])));
    // The `k8s.pod.status_reason` metric name is a k8s key, so the header names the pin.
    expect(out).toBe(`# chant: semconv k8s ${SEMCONV_PIN.source}@${SEMCONV_PIN.version} (k8s_cluster)

receivers:
  k8s_cluster:
    auth_type: serviceAccount
    collection_interval: 30s
    node_conditions_to_report: [Ready, MemoryPressure]
    allocatable_types_to_report: [cpu, memory]
    k8s_leader_elector: k8s_leader_elector
    metrics:
      k8s.pod.status_reason:
        enabled: true
`);
    expect(problems(cluster)).toEqual([]);
  });

  test("renders in a metrics pipeline and reports no endpoint", () => {
    const cluster = new K8sClusterReceiver({});
    const debug = new DebugExporter({});
    const yaml = collectorYaml([cluster, debug, new Pipeline({ signal: "metrics", receivers: [cluster], exporters: [debug] })]);
    const parsed = load(yaml) as any;
    expect(parsed.receivers).toEqual({ k8s_cluster: {} });
    expect(parsed.service.pipelines.metrics.receivers).toEqual(["k8s_cluster"]);
    const topo = collectorTopology(parsed);
    expect(topo.components.find((c) => c.id === "k8s_cluster")?.endpoints ?? []).toEqual([]);
  });

  test("an unknown distribution is reported", () => {
    // @ts-expect-error: not a distribution
    expect(problems(new K8sClusterReceiver({ distribution: "eks" }))).toEqual([
      'distribution "eks" is not kubernetes or openshift',
    ]);
  });
});

describe("kubeletstats receiver", () => {
  test("serializes the usual per-node agent shape, and reports the kubelet as its endpoint", () => {
    const kubelet = new KubeletStatsReceiver({
      auth_type: "serviceAccount",
      endpoint: "https://${env:K8S_NODE_NAME}:10250",
      insecure_skip_verify: true,
      collection_interval: "20s",
      metric_groups: ["node", "pod", "container"],
      extra_metadata_labels: ["container.id"],
      node: "${env:K8S_NODE_NAME}",
    });
    const yaml = collectorYaml([kubelet]);
    expect(yaml).toBe(`receivers:
  kubeletstats:
    auth_type: serviceAccount
    endpoint: https://\${env:K8S_NODE_NAME}:10250
    insecure_skip_verify: true
    collection_interval: 20s
    metric_groups: [node, pod, container]
    extra_metadata_labels: [container.id]
    node: \${env:K8S_NODE_NAME}
`);
    const topo = collectorTopology(load(yaml) as any);
    expect(topo.components.find((c) => c.id === "kubeletstats")?.endpoints).toEqual([
      "https://${env:K8S_NODE_NAME}:10250",
    ]);
    expect(problems(kubelet)).toEqual([]);
  });

  test("tls auth, the default, needs a client certificate", () => {
    expect(problems(new KubeletStatsReceiver({}))).toEqual([
      "auth_type defaults to tls, which needs cert_file and key_file; in a pod set auth_type: serviceAccount",
    ]);
    expect(problems(new KubeletStatsReceiver({ auth_type: "tls", cert_file: "/c" }))).toEqual([
      "auth_type tls needs cert_file and key_file; in a pod set auth_type: serviceAccount",
    ]);
    expect(problems(new KubeletStatsReceiver({ auth_type: "tls", cert_file: "/c", key_file: "/k" }))).toEqual([]);
  });

  test("an empty metric_groups collects nothing", () => {
    expect(problems(new KubeletStatsReceiver({ auth_type: "none", metric_groups: [] }))).toEqual([
      "metric_groups is empty, so no kubelet metric is collected",
    ]);
  });
});
