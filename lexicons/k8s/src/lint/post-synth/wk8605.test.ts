/**
 * WK8605: a collector config that reads the node, in a workload that
 * doesn't give it the node name or the host mounts (chant #3103).
 */
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { expandComposite } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { DebugExporter, NodeAgent, OtlpReceiver, Pipeline } from "@intentius/chant-lexicon-otel";
import { k8sSerializer } from "../../serializer";
import { OtelCollector } from "../../composites/otel-collector";
import { wk8605 } from "./wk8605";

function built(instances: Record<string, unknown>): PostSynthContext {
  const entities = new Map<string, Declarable>();
  for (const [name, instance] of Object.entries(instances)) {
    for (const [k, v] of expandComposite(name, instance as never)) entities.set(k, v);
  }
  const out = k8sSerializer.serialize(entities);
  return makePostSynthCtx("k8s", typeof out === "string" ? out : out.primary);
}

const yaml = (...docs: object[]) => makePostSynthCtx("k8s", docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n"));

const NODE_CONFIG = `
receivers:
  hostmetrics: { root_path: /hostfs, scrapers: { cpu: {} } }
  filelog: { include: [/var/log/pods/*/*/*.log] }
processors:
  k8sattributes: { filter: { node_from_env_var: K8S_NODE_NAME } }
exporters: { debug: {} }
service:
  pipelines:
    metrics: { receivers: [hostmetrics], processors: [k8sattributes], exporters: [debug] }
    logs: { receivers: [filelog], processors: [k8sattributes], exporters: [debug] }
`;

function daemonSet(pod: { env?: object[]; mounts?: object[]; volumes?: object[] }): object[] {
  return [
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "agent-config", namespace: "obs" }, data: { "config.yaml": NODE_CONFIG } },
    {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: "agent", namespace: "obs" },
      spec: {
        selector: { matchLabels: { app: "agent" } },
        template: {
          metadata: { labels: { app: "agent" } },
          spec: {
            containers: [{
              name: "otelcol",
              image: "otel/opentelemetry-collector-contrib:0.130.0",
              args: ["--config=/conf/config.yaml"],
              ...(pod.env ? { env: pod.env } : {}),
              volumeMounts: [{ name: "conf", mountPath: "/conf" }, ...(pod.mounts ?? [])],
            }],
            volumes: [{ name: "conf", configMap: { name: "agent-config" } }, ...(pod.volumes ?? [])],
          },
        },
      },
    },
  ];
}

const NODE_ENV = { name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } };

describe("WK8605: node-reading collector config without the node", () => {
  const gateway = new DebugExporter({});

  test("OtelCollector running NodeAgent passes: the composite adds what the config reads", () => {
    const agent = NodeAgent({ exporters: [gateway], kubeletStats: true });
    expect(wk8605.check(built({ agent: OtelCollector({ config: Object.values(agent.members) }) }))).toEqual([]);
  });

  test("a config that reads nothing from the node is not checked", () => {
    const rx = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const r = OtelCollector({ config: [new Pipeline({ signal: "traces", receivers: [rx], exporters: [gateway] })] });
    expect(wk8605.check(built({ r }))).toEqual([]);
  });

  test("a hand-written DaemonSet without the variable or mounts is reported, naming each gap", () => {
    const d = wk8605.check(yaml(...daemonSet({})));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "WK8605", severity: "warning", entity: "agent" });
    expect(d[0].message).toContain("DaemonSet obs/agent");
    expect(d[0].message).toContain("no K8S_NODE_NAME variable (set it from spec.nodeName");
    expect(d[0].message).toContain("hostmetrics reads host / at /hostfs");
    expect(d[0].message).toContain("filelog reads host /var/log/pods at /var/log/pods");
  });

  test("the collector's newer names (host_metrics, file_log, k8s_attributes) are reported the same", () => {
    const docs = daemonSet({}) as Array<Record<string, any>>;
    docs[0].data["config.yaml"] = NODE_CONFIG.replace(/hostmetrics/g, "host_metrics")
      .replace(/filelog/g, "file_log")
      .replace(/k8sattributes/g, "k8s_attributes");
    const d = wk8605.check(yaml(...docs));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("no K8S_NODE_NAME variable (set it from spec.nodeName");
    expect(d[0].message).toContain("host_metrics reads host / at /hostfs");
    expect(d[0].message).toContain("file_log reads host /var/log/pods at /var/log/pods");
  });

  test("the variable from any source and covering hostPath mounts pass, including partial host root mounts", () => {
    const d = wk8605.check(yaml(...daemonSet({
      env: [{ name: "K8S_NODE_NAME", value: "fixed" }],
      mounts: [
        { name: "proc", mountPath: "/hostfs/proc", readOnly: true },
        { name: "varlog", mountPath: "/var/log", readOnly: true },
      ],
      volumes: [
        { name: "proc", hostPath: { path: "/proc" } },
        { name: "varlog", hostPath: { path: "/var/log" } },
      ],
    })));
    expect(d).toEqual([]);
  });

  test("a mount at the right path from the wrong host directory, or from a non-hostPath volume, doesn't count", () => {
    const d = wk8605.check(yaml(...daemonSet({
      env: [NODE_ENV],
      mounts: [
        { name: "hostfs", mountPath: "/hostfs" },
        { name: "pods", mountPath: "/var/log/pods" },
      ],
      volumes: [
        { name: "hostfs", emptyDir: {} },
        { name: "pods", hostPath: { path: "/var/lib/pods" } },
      ],
    })));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("hostmetrics reads host /");
    expect(d[0].message).toContain("filelog reads host /var/log/pods");
    expect(d[0].message).not.toContain("K8S_NODE_NAME");
  });

  test("a sidecar's variable doesn't count for the collector container", () => {
    const docs = daemonSet({}) as Array<Record<string, any>>;
    docs[1].spec.template.spec.containers.push({ name: "sidecar", image: "busybox", env: [NODE_ENV] });
    const d = wk8605.check(yaml(...docs));
    expect(d[0].message).toContain("no K8S_NODE_NAME variable");
  });

  test("defaults.daemonSet appends containers rather than replacing them, so the composite's additions stay", () => {
    const agent = NodeAgent({ exporters: [gateway] });
    const r = OtelCollector({
      config: Object.values(agent.members),
      defaults: { daemonSet: { spec: { template: { spec: { containers: [{ name: "sidecar", image: "busybox" }] } } } } },
    });
    expect(wk8605.check(built({ r }))).toEqual([]);
  });
});
