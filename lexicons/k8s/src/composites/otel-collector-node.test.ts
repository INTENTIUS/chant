import { describe, expect, test } from "vitest";
import {
  DebugExporter,
  FileLogReceiver,
  HostMetricsReceiver,
  NodeAgent,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
} from "@intentius/chant-lexicon-otel";
import { collectorNodeAccess, fixedDirectory } from "./otel-collector-node";
import { OtelCollector } from "./otel-collector";
import { GkeOtelCollector } from "./gke-otel-collector";

const NODE_NAME = { name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } };

/** A config whose pipelines run the given receivers and processors. */
function cfg(receivers: Record<string, unknown>, processors: Record<string, unknown> = {}) {
  return {
    receivers,
    processors,
    service: { pipelines: { logs: { receivers: Object.keys(receivers), processors: Object.keys(processors), exporters: ["debug"] } } },
  };
}

type Props = { props: Record<string, any> };
const podSpec = (r: { daemonSet: unknown }) => (r.daemonSet as Props).props.spec.template.spec;
const containerOf = (r: { daemonSet: unknown }) => podSpec(r).containers[0];

describe("fixedDirectory", () => {
  test.each([
    ["/var/log/pods/*/*/*.log", "/var/log/pods"],
    ["/var/log/containers/*.log", "/var/log/containers"],
    ["/var/log/syslog", "/var/log"],
    ["/var/log/{a,b}/x.log", "/var/log"],
    ["/*.log", undefined],
    ["logs/*.log", undefined],
  ])("%s gives %s", (pattern, dir) => {
    expect(fixedDirectory(pattern)).toBe(dir);
  });
});

describe("collectorNodeAccess", () => {
  test("a config that reads nothing from the node needs nothing", () => {
    expect(collectorNodeAccess(cfg({ otlp: {} }, { batch: {}, k8sattributes: {} }))).toEqual({ env: [], mounts: [], readsLogs: false });
  });

  test("k8sattributes filtering by node gets its variable from spec.nodeName", () => {
    const access = collectorNodeAccess(cfg({ otlp: {} }, { "k8sattributes/node": { filter: { node_from_env_var: "KUBE_NODE_NAME" } } }));
    expect(access.env).toEqual([{ name: "KUBE_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } }]);
  });

  test("the collector's newer names read the node the same as the old ones", () => {
    const old = collectorNodeAccess(
      cfg(
        { kubeletstats: { node: "${env:K8S_NODE_NAME}" }, hostmetrics: { root_path: "/hostfs" }, filelog: { include: ["/var/log/pods/*/*/*.log"] } },
        { k8sattributes: { filter: { node_from_env_var: "KUBE_NODE_NAME" } } },
      ),
    );
    const renamed = collectorNodeAccess(
      cfg(
        { kubelet_stats: { node: "${env:K8S_NODE_NAME}" }, host_metrics: { root_path: "/hostfs" }, file_log: { include: ["/var/log/pods/*/*/*.log"] } },
        { k8s_attributes: { filter: { node_from_env_var: "KUBE_NODE_NAME" } } },
      ),
    );
    expect(renamed.env).toEqual(old.env);
    expect(renamed.mounts.map(({ component: _, ...m }) => m)).toEqual(old.mounts.map(({ component: _, ...m }) => m));
    expect(renamed.readsLogs).toBe(true);
    expect(renamed.mounts).toHaveLength(2);
  });

  test("kubeletstats: node and a NODE_NAME endpoint get the node name, a NODE_IP endpoint the host IP", () => {
    expect(collectorNodeAccess(cfg({ kubeletstats: { endpoint: "https://${env:K8S_NODE_NAME}:10250", node: "${env:K8S_NODE_NAME}" } })).env).toEqual([NODE_NAME]);
    expect(collectorNodeAccess(cfg({ kubeletstats: { endpoint: "https://${env:K8S_NODE_IP}:10250" } })).env).toEqual([
      { name: "K8S_NODE_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
    ]);
    // A variable whose meaning can't be told from its name is the caller's to set.
    expect(collectorNodeAccess(cfg({ kubeletstats: { endpoint: "${env:KUBELET}:10250" } })).env).toEqual([]);
  });

  test("hostmetrics with root_path mounts the host root there; without it, nothing", () => {
    expect(collectorNodeAccess(cfg({ hostmetrics: { root_path: "/hostfs/" } })).mounts).toEqual([
      { name: "hostfs", hostPath: "/", mountPath: "/hostfs", component: "hostmetrics", partial: true, mountPropagation: "HostToContainer" },
    ]);
    expect(collectorNodeAccess(cfg({ hostmetrics: { scrapers: { cpu: {} } } })).mounts).toEqual([]);
  });

  test("filelog mounts the outermost fixed directory of its patterns, and /var/log/pods behind /var/log/containers", () => {
    const access = collectorNodeAccess(cfg({
      filelog: { include: ["/var/log/pods/*/*/*.log", "/var/log/pods/x/*.log"] },
      "filelog/symlinks": { include: ["/var/log/containers/*.log"] },
    }));
    expect(access.mounts.map((m) => [m.name, m.hostPath, m.mountPath])).toEqual([
      ["host-var-log-pods", "/var/log/pods", "/var/log/pods"],
      ["host-var-log-containers", "/var/log/containers", "/var/log/containers"],
    ]);
    expect(access.readsLogs).toBe(true);
  });

  test("a log directory covering the config directory, or under the host root mount, is not mounted", () => {
    expect(collectorNodeAccess(cfg({ filelog: { include: ["/etc/**/*.log"] } })).mounts).toEqual([]);
    const access = collectorNodeAccess(cfg({ hostmetrics: { root_path: "/hostfs" }, filelog: { include: ["/hostfs/var/log/*.log"] } }));
    expect(access.mounts.map((m) => m.name)).toEqual(["hostfs"]);
  });

  test("a component no pipeline runs needs nothing", () => {
    const access = collectorNodeAccess({
      receivers: { otlp: {}, filelog: { include: ["/var/log/pods/*.log"] } },
      service: { pipelines: { logs: { receivers: ["otlp"], exporters: ["debug"] } } },
    });
    expect(access.mounts).toEqual([]);
  });
});

describe("OtelCollector running NodeAgent", () => {
  const gateway = new OtlpExporter({ name: "gateway", endpoint: "otel-gateway.observability.svc:4317", tls: { insecure: true } });
  const agent = (props: Parameters<typeof NodeAgent>[0]) => Object.values(NodeAgent(props).members);

  test("gets the node name, read-only host mounts, group access to the logs and nodes/stats", () => {
    const r = OtelCollector({ config: agent({ exporters: [gateway], kubeletStats: true }) });
    const c = containerOf(r);
    expect(c.env).toEqual([NODE_NAME]);
    expect(c.volumeMounts).toEqual([
      { name: "config", mountPath: "/etc/otel", readOnly: true },
      { name: "hostfs", mountPath: "/hostfs", readOnly: true, mountPropagation: "HostToContainer" },
      { name: "host-var-log-pods", mountPath: "/var/log/pods", readOnly: true },
    ]);
    expect(c.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10001 });
    const pod = podSpec(r);
    expect(pod.volumes).toEqual([
      { name: "config", configMap: { name: "otel-collector-config" } },
      { name: "hostfs", hostPath: { path: "/" } },
      { name: "host-var-log-pods", hostPath: { path: "/var/log/pods" } },
    ]);
    expect(pod.securityContext).toEqual({ supplementalGroups: [0] });
    const rules = (r.clusterRole as unknown as Props).props.rules;
    expect(rules).toContainEqual({ apiGroups: [""], resources: ["nodes/stats"], verbs: ["get"] });
  });

  test("logAccess root runs the container as user 0 instead of adding group 0", () => {
    const r = OtelCollector({ config: agent({ exporters: [gateway] }), logAccess: "root" });
    expect(containerOf(r).securityContext).toMatchObject({ runAsNonRoot: false, runAsUser: 0, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false });
    expect(podSpec(r).securityContext).toBeUndefined();
  });

  test("without logs or host metrics, only the node name is added", () => {
    const r = OtelCollector({ config: agent({ exporters: [gateway], hostMetrics: false, containerLogs: false }) });
    expect(containerOf(r).env).toEqual([NODE_NAME]);
    expect(containerOf(r).volumeMounts).toHaveLength(1);
    expect(podSpec(r).securityContext).toBeUndefined();
  });

  test("a custom nodeNameEnv is the variable set", () => {
    const r = OtelCollector({ config: agent({ exporters: [gateway], nodeNameEnv: "MY_NODE", kubeletStats: true }) });
    expect(containerOf(r).env).toEqual([{ name: "MY_NODE", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } }]);
  });

  test("a hand-declared filelog and hostmetrics config is wired the same way", () => {
    const logs = new FileLogReceiver({ include: ["/var/log/pods/*/*/*.log"] });
    const host = new HostMetricsReceiver({ root_path: "/hostfs", scrapers: { cpu: {} } });
    const debug = new DebugExporter({});
    const r = OtelCollector({
      config: [
        new Pipeline({ signal: "logs", receivers: [logs], exporters: [debug] }),
        new Pipeline({ signal: "metrics", receivers: [host], exporters: [debug] }),
      ],
    });
    expect(containerOf(r).env).toBeUndefined();
    expect(podSpec(r).volumes.map((v: { name: string }) => v.name)).toEqual(["config", "hostfs", "host-var-log-pods"]);
  });
});

describe("configs that don't read the node keep their output", () => {
  test("OtelCollector's default config adds no env, volume or pod security context", () => {
    const r = OtelCollector({});
    expect(containerOf(r).env).toBeUndefined();
    expect(containerOf(r).volumeMounts).toEqual([{ name: "config", mountPath: "/etc/otel", readOnly: true }]);
    expect(Object.keys(podSpec(r))).toEqual(["serviceAccountName", "containers", "volumes", "tolerations"]);
  });

  test("an OTLP-only full config adds nothing either", () => {
    const rx = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const r = OtelCollector({ config: [new Pipeline({ signal: "traces", receivers: [rx], exporters: [new DebugExporter({})] })] });
    expect(containerOf(r).env).toBeUndefined();
    expect(podSpec(r).volumes).toHaveLength(1);
  });

  test("GkeOtelCollector, whose config is OTLP only, adds nothing", () => {
    const r = GkeOtelCollector({ clusterName: "c", projectId: "p" });
    expect(containerOf(r).env).toBeUndefined();
    expect(Object.keys(podSpec(r))).toEqual(["serviceAccountName", "containers", "volumes", "tolerations"]);
  });
});
