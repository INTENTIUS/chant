import { describe, expect, test } from "vitest";
import { DebugExporter, KubeletStatsReceiver, OtlpReceiver, Pipeline, type CollectorConfig } from "@intentius/chant-lexicon-otel";
import { agentClusterRules, namespacedRoles } from "./otel-collector-rbac";
import { OtelCollector } from "./otel-collector";
import { GkeOtelCollector } from "./gke-otel-collector";

const READ = ["get", "list", "watch"];
const BASE = [
  { apiGroups: [""], resources: ["pods", "namespaces", "nodes"], verbs: READ },
  { apiGroups: ["apps"], resources: ["replicasets"], verbs: READ },
];

function cfg(c: Partial<CollectorConfig>): CollectorConfig {
  return { service: { pipelines: {} }, ...c } as CollectorConfig;
}

describe("agentClusterRules", () => {
  test("an OTLP-only config gets k8sattributes' rules and nothing else", () => {
    expect(agentClusterRules(cfg({ receivers: { otlp: {} } }))).toEqual(BASE);
  });

  test("k8sattributes extracting from a deployment adds deployments", () => {
    const rules = agentClusterRules(
      cfg({ processors: { "k8sattributes/x": { extract: { labels: [{ key: "team", from: "deployment" }] } } } as any }),
    );
    expect(rules[1]).toEqual({ apiGroups: ["apps"], resources: ["replicasets", "deployments"], verbs: READ });
  });

  test("kubeletstats gets nodes/stats", () => {
    expect(agentClusterRules(cfg({ receivers: { kubeletstats: { auth_type: "serviceAccount" } } as any }))).toEqual([
      ...BASE,
      { apiGroups: [""], resources: ["nodes/stats"], verbs: ["get"] },
    ]);
  });

  test.each([
    [{ extra_metadata_labels: ["container.id"] }],
    [{ metrics: { "k8s.pod.cpu_limit_utilization": { enabled: true } } }],
    [{ metrics: { "k8s.container.memory_request_utilization": { enabled: true } } }],
  ])("kubeletstats needing the kubelet's /pods gets nodes/proxy (%o)", (extra) => {
    const rules = agentClusterRules(cfg({ receivers: { "kubeletstats/node": { auth_type: "serviceAccount", ...extra } } as any }));
    expect(rules[2]).toEqual({ apiGroups: [""], resources: ["nodes/stats", "nodes/proxy"], verbs: ["get"] });
  });

  test("a disabled utilization metric does not add nodes/proxy", () => {
    const rules = agentClusterRules(
      cfg({ receivers: { kubeletstats: { metrics: { "k8s.pod.cpu_limit_utilization": { enabled: false } } } } as any }),
    );
    expect(rules[2].resources).toEqual(["nodes/stats"]);
  });

  test("kubeletstats with k8s_api_config reads persistent volumes and claims", () => {
    const rules = agentClusterRules(cfg({ receivers: { kubeletstats: { k8s_api_config: { auth_type: "serviceAccount" } } } as any }));
    expect(rules.at(-1)).toEqual({ apiGroups: [""], resources: ["persistentvolumeclaims", "persistentvolumes"], verbs: ["get"] });
  });
});

describe("the agent ClusterRole", () => {
  const rulesOf = (r: { clusterRole: unknown }) => (r.clusterRole as { props: { rules: unknown } }).props.rules;

  test("OtelCollector and GkeOtelCollector grant k8sattributes' rules by default", () => {
    expect(rulesOf(OtelCollector({}))).toEqual(BASE);
    expect(rulesOf(GkeOtelCollector({ clusterName: "c", projectId: "p" }))).toEqual(BASE);
  });

  test("an OtelCollector config with kubeletstats gets its rules", () => {
    const kubelet = new KubeletStatsReceiver({ auth_type: "serviceAccount", extra_metadata_labels: ["container.id"] });
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const debug = new DebugExporter({});
    const agent = OtelCollector({ config: [new Pipeline({ signal: "metrics", receivers: [otlp, kubelet], exporters: [debug] })] });
    expect(rulesOf(agent)).toEqual([...BASE, { apiGroups: [""], resources: ["nodes/stats", "nodes/proxy"], verbs: ["get"] }]);
  });

  test("defaults.clusterRole.rules are appended", () => {
    const extra = { apiGroups: [""], resources: ["services"], verbs: READ };
    expect(rulesOf(OtelCollector({ defaults: { clusterRole: { rules: [extra] } } }))).toEqual([...BASE, extra]);
  });
});

describe("namespacedRoles", () => {
  const base = {
    key: "endpoints",
    name: "agent-endpoints",
    rules: [{ apiGroups: [""], resources: ["endpoints"], verbs: READ }],
    labels: { app: "x" },
    serviceAccount: { name: "agent-sa", namespace: "agents" },
  };

  test("no namespaces, no members", () => {
    expect(namespacedRoles({ ...base, namespaces: [] })).toEqual({});
  });

  test("the first namespace keeps the plain member names, the rest are suffixed", () => {
    expect(Object.keys(namespacedRoles({ ...base, namespaces: ["obs", "team-a", "b2"] }))).toEqual([
      "endpointsRole",
      "endpointsRoleBinding",
      "endpointsRoleInTeamA",
      "endpointsRoleBindingInTeamA",
      "endpointsRoleInB2",
      "endpointsRoleBindingInB2",
    ]);
  });

  test("namespaces that give the same member name are refused", () => {
    expect(() => namespacedRoles({ ...base, namespaces: ["obs", "a-b", "a--b"] })).toThrow(/a-b and a--b/);
  });

  test("defaults apply to each Role", () => {
    const out = namespacedRoles({ ...base, namespaces: ["one", "two"], roleDefaults: { metadata: { annotations: { x: "y" } } } });
    for (const key of ["endpointsRole", "endpointsRoleInTwo"]) {
      expect((out[key] as any).props.metadata.annotations).toEqual({ x: "y" });
    }
  });
});
