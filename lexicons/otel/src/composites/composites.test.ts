/**
 * The `NodeAgent` composite: validation, defaults, the switches, and that the
 * config it declares passes the lexicon's own config checks.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { NodeAgent, nodeAgentPropsProblem, type NodeAgentProps } from "./index";
import { OtlpExporter, PrometheusExporter } from "../components/exporters";
import { collectorYaml } from "../collector";
import { validateCollectorConfig } from "../validate-config";
import type { CollectorConfig } from "../model";
import { SEMCONV_PIN } from "../define";
import { semconvUsage } from "../semconv";

const gateway = new OtlpExporter({ name: "gateway", endpoint: "otel-gateway.observability.svc:4317", tls: { insecure: true } });
const base: NodeAgentProps = { exporters: [gateway] };

/** A section of the built config, read loosely: the assertions name the keys they expect. */
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function configOf(props: NodeAgentProps): CollectorConfig {
  const agent = NodeAgent(props);
  return load(collectorYaml(Object.values(agent.members) as Declarable[])) as CollectorConfig;
}

describe("NodeAgent validation", () => {
  test("needs at least one exporter", () => {
    expect(() => NodeAgent({ exporters: [] })).toThrow(/NodeAgent: exporters must name at least one exporter/);
    expect(nodeAgentPropsProblem({ ...base, metricExporters: [] })).toMatch(/metricExporters/);
  });

  test("rejects a memory limit that is not a positive whole number, and a node env var that is not a name", () => {
    expect(() => NodeAgent({ ...base, memoryLimitMib: 0 })).toThrow(/memoryLimitMib/);
    expect(() => NodeAgent({ ...base, memoryLimitMib: 1.5 })).toThrow(/memoryLimitMib/);
    expect(() => NodeAgent({ ...base, nodeNameEnv: "NODE-NAME" })).toThrow(/not an environment variable name/);
    expect(nodeAgentPropsProblem(base)).toBeUndefined();
  });
});

describe("NodeAgent defaults", () => {
  const config = configOf(base);

  test("the config passes every config check", () => {
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("OTLP, host metrics and container logs in; memory_limiter first and batch last", () => {
    expect(Object.keys(config.receivers ?? {}).sort()).toEqual(["filelog", "hostmetrics", "otlp"]);
    const pipelines = config.service?.pipelines ?? {};
    expect(Object.keys(pipelines).sort()).toEqual(["logs", "metrics", "traces"]);
    for (const p of Object.values(pipelines)) {
      expect(p.processors).toEqual(["memory_limiter", "k8sattributes", "resourcedetection", "batch"]);
      expect(p.exporters).toEqual(["otlp/gateway"]);
    }
    expect(pipelines.metrics.receivers).toEqual(["otlp", "hostmetrics"]);
    expect(pipelines.logs.receivers).toEqual(["filelog", "otlp"]);
    expect(pipelines.traces.receivers).toEqual(["otlp"]);
  });

  test("k8sattributes keeps to this node's pods and matches log records by pod uid", () => {
    const k8s = config.processors?.k8sattributes as Loose;
    expect(k8s.filter).toEqual({ node_from_env_var: "K8S_NODE_NAME" });
    expect(k8s.extract.metadata).toContain("k8s.pod.uid");
    expect(k8s.pod_association.map((a: Loose) => a.sources[0].name ?? a.sources[0].from)).toEqual(["k8s.pod.ip", "k8s.pod.uid", "connection"]);
  });

  test("the agent's own container logs are left out", () => {
    const filelog = config.receivers?.filelog as Loose;
    expect(filelog.include).toEqual(["/var/log/pods/*/*/*.log"]);
    expect(filelog.exclude).toEqual(["/var/log/pods/*/otel-collector/*.log"]);
    expect(filelog.operators).toEqual([{ type: "container", id: "container-parser" }]);
  });

  test("memory_limiter defaults to 400 MiB with a quarter of it as spike limit, and health_check is served", () => {
    expect(config.processors?.memory_limiter).toMatchObject({ limit_mib: 400, spike_limit_mib: 100 });
    expect(config.service?.extensions).toEqual(["health_check"]);
    expect(config.extensions?.health_check).toEqual({ endpoint: "0.0.0.0:13133" });
  });

  test("no tail sampling and no kubeletstats", () => {
    expect(config.processors?.tail_sampling).toBeUndefined();
    expect(config.receivers?.kubeletstats).toBeUndefined();
  });
});

describe("NodeAgent options", () => {
  test("clusterName adds a resource processor before batch", () => {
    const config = configOf({ ...base, clusterName: "prod-eu-1" });
    expect(config.service?.pipelines?.traces.processors).toEqual(["memory_limiter", "k8sattributes", "resourcedetection", "resource", "batch"]);
    expect(config.processors?.resource).toEqual({ attributes: [{ key: "k8s.cluster.name", value: "prod-eu-1", action: "upsert" }] });
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("metricExporters sends metrics elsewhere", () => {
    const scrape = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
    const config = configOf({ ...base, metricExporters: [scrape] });
    expect(config.service?.pipelines?.metrics.exporters).toEqual(["prometheus"]);
    expect(config.service?.pipelines?.traces.exporters).toEqual(["otlp/gateway"]);
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("kubeletStats reads this node's kubelet with the service account, named by the node env var", () => {
    const config = configOf({ ...base, kubeletStats: { interval: "1m" }, nodeNameEnv: "NODE_NAME" });
    expect(config.receivers?.kubeletstats).toEqual({
      collection_interval: "1m",
      auth_type: "serviceAccount",
      endpoint: "https://${env:NODE_NAME}:10250",
      insecure_skip_verify: true,
      node: "${env:NODE_NAME}",
    });
    expect(config.service?.pipelines?.metrics.receivers).toEqual(["otlp", "hostmetrics", "kubeletstats"]);
    expect((config.processors?.k8sattributes as Loose).filter).toEqual({ node_from_env_var: "NODE_NAME" });
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("host metrics, container logs and health_check can be turned off; OTLP stays", () => {
    const agent = NodeAgent({ ...base, hostMetrics: false, containerLogs: false, healthCheck: false });
    expect(Object.keys(agent.members).sort()).toEqual([
      "batch",
      "k8sAttributes",
      "logs",
      "memoryLimiter",
      "metrics",
      "otlp",
      "resourceDetection",
      "traces",
    ]);
    const config = configOf({ ...base, hostMetrics: false, containerLogs: false, healthCheck: false });
    expect(Object.keys(config.receivers ?? {})).toEqual(["otlp"]);
    expect(config.service?.extensions).toBeUndefined();
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("host metrics and container logs take their own settings", () => {
    const config = configOf({ ...base, hostMetrics: { interval: "1m", rootPath: "/host" }, containerLogs: { selfContainer: "agent" } });
    expect(config.receivers?.hostmetrics).toMatchObject({ collection_interval: "1m", root_path: "/host" });
    expect((config.receivers?.filelog as Loose).exclude).toEqual(["/var/log/pods/*/agent/*.log"]);
  });
});

describe("NodeAgent semconv", () => {
  test("the YAML names the k8s semantic conventions its keys follow", () => {
    const yaml = collectorYaml(Object.values(NodeAgent({ ...base, clusterName: "prod-eu-1" }).members) as Declarable[]);
    expect(yaml.split("\n")[0]).toBe(`# chant: semconv k8s ${SEMCONV_PIN.source}@${SEMCONV_PIN.version} (k8sattributes, resource)`);
  });

  test("k8s_cluster and k8sattributes as names are not k8s keys", () => {
    expect(semconvUsage({ receivers: { k8s_cluster: {} }, processors: { k8sattributes: {}, "resource/k8s": {} } })).toEqual([]);
    expect(semconvUsage({ processors: { "transform/x": { statements: ['delete_matching_keys(resource.attributes, "^k8s\\\\.pod\\\\..*")'] } } })).toEqual([
      { namespace: "k8s", ...SEMCONV_PIN, components: ["transform/x"] },
    ]);
  });
});
