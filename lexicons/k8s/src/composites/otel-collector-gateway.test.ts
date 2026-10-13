import { describe, expect, test } from "vitest";
import { load, loadAll } from "js-yaml";
import { expandComposite } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  DebugExporter,
  K8sClusterReceiver,
  K8sLeaderElectorExtension,
  LoadBalancingExporter,
  OtlpReceiver,
  Pipeline,
  PrometheusExporter,
  defineComponent,
  Service as CollectorService,
  TailSamplingProcessor,
  collectorTopology,
  validateCollectorConfig,
  type CollectorConfig,
} from "@intentius/chant-lexicon-otel";
import { k8sSerializer } from "../serializer";
import { OtelCollector } from "./otel-collector";
import { OtelCollectorGateway, gatewayExporter } from "./otel-collector-gateway";
import { OTEL_COLLECTOR_ANNOTATIONS as A } from "./otel-collector-shape";

function p(member: unknown): any {
  return (member as { props: unknown }).props;
}

function config(result: { configMap: unknown }): CollectorConfig {
  return load(p(result.configMap).data["config.yaml"]) as CollectorConfig;
}

function agentOf(exporter: ReturnType<typeof gatewayExporter>, props: Record<string, unknown> = {}) {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
  return OtelCollector({
    ...props,
    config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [exporter] })],
  });
}

function manifests(instances: Record<string, any>): Array<Record<string, any>> {
  const entities = new Map<string, Declarable>();
  for (const [name, instance] of Object.entries(instances)) {
    for (const [k, v] of expandComposite(name, instance)) entities.set(k, v);
  }
  const out = k8sSerializer.serialize(entities);
  return loadAll(typeof out === "string" ? out : out.primary) as Array<Record<string, any>>;
}

describe("OtelCollectorGateway", () => {
  test("returns a Deployment, two Services, a ServiceAccount and a ConfigMap, and no RBAC by default", () => {
    const gw = OtelCollectorGateway({});
    for (const key of ["deployment", "service", "headlessService", "serviceAccount", "configMap"]) {
      expect((gw as any)[key], key).toBeDefined();
    }
    expect(gw.clusterRole).toBeUndefined();
    expect(gw.clusterRoleBinding).toBeUndefined();
  });

  test("defaults to two replicas of otel-gateway in observability, running the default config", () => {
    const gw = OtelCollectorGateway({});
    const d = p(gw.deployment);
    expect(d.metadata).toMatchObject({ name: "otel-gateway", namespace: "observability" });
    expect(d.spec.replicas).toBe(2);
    expect(d.spec.template.spec.tolerations).toBeUndefined();
    expect(d.spec.template.spec.serviceAccountName).toBe("otel-gateway-sa");
    expect(validateCollectorConfig(config(gw))).toEqual([]);
  });

  test("the ClusterIP Service and the headless Service expose the config's receiver ports", () => {
    const gw = OtelCollectorGateway({});
    const ports = [
      { name: "otlp-grpc", port: 4317, targetPort: "otlp-grpc", protocol: "TCP" },
      { name: "otlp-http", port: 4318, targetPort: "otlp-http", protocol: "TCP" },
    ];
    expect(p(gw.service).spec).toEqual({ type: "ClusterIP", selector: { "app.kubernetes.io/name": "otel-gateway" }, ports });
    expect(p(gw.headlessService).metadata.name).toBe("otel-gateway-headless");
    expect(p(gw.headlessService).spec).toEqual({ clusterIP: "None", selector: { "app.kubernetes.io/name": "otel-gateway" }, ports });
    const container = p(gw.deployment).spec.template.spec.containers[0];
    expect(container.ports.map((x: any) => x.containerPort)).toEqual([4317, 4318, 13133]);
    expect(container.readinessProbe).toEqual({ httpGet: { path: "/", port: "health" } });
    expect(container.securityContext.capabilities).toEqual({ drop: ["ALL"] });
  });

  test("a UDP receiver's port is UDP on the container and the Services, and the prometheus exporter's port is exposed (#3122)", () => {
    const StatsdReceiver = defineComponent<{ endpoint: string }>()({
      kind: "receiver",
      type: "statsd",
      pin: { source: "github.com/open-telemetry/opentelemetry-collector-contrib", version: "v0.130.0" },
    });
    const statsd = new StatsdReceiver({ endpoint: "0.0.0.0:8125" });
    const prom = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
    const gw = OtelCollectorGateway({ config: [new Pipeline({ signal: "metrics", receivers: [statsd], exporters: [prom] })] });
    expect(p(gw.service).spec.ports).toEqual([
      { name: "statsd", port: 8125, targetPort: "statsd", protocol: "UDP" },
      { name: "prometheus", port: 8889, targetPort: "prometheus", protocol: "TCP" },
    ]);
    const container = p(gw.deployment).spec.template.spec.containers[0];
    expect(container.ports).toEqual([
      { containerPort: 8125, name: "statsd", protocol: "UDP" },
      { containerPort: 8889, name: "prometheus" },
    ]);
  });

  test("clusterRules adds a ClusterRole bound to the gateway's ServiceAccount", () => {
    const rules = [{ apiGroups: [""], resources: ["pods", "nodes"], verbs: ["get", "list", "watch"] }];
    const gw = OtelCollectorGateway({ name: "gw", namespace: "obs", clusterRules: rules });
    expect(p(gw.clusterRole).rules).toEqual(rules);
    expect(p(gw.clusterRoleBinding).subjects).toEqual([{ kind: "ServiceAccount", name: "gw-sa", namespace: "obs" }]);
    expect(p(gw.clusterRoleBinding).roleRef.name).toBe("gw-role");
  });

  test("an enabled k8s_leader_elector adds a Role for Leases in its lease_namespace", () => {
    const elector = new K8sLeaderElectorExtension({ lease_name: "otel-cluster", lease_namespace: "leases" });
    const cluster = new K8sClusterReceiver({ k8s_leader_elector: elector.componentId });
    const debug = new DebugExporter({});
    const pipeline = new Pipeline({ signal: "metrics", receivers: [cluster], exporters: [debug] });
    const gw = OtelCollectorGateway({ name: "gw", namespace: "obs", config: [pipeline, new CollectorService({ extensions: [elector] })] });
    expect(p(gw.leaseRole).metadata).toMatchObject({ name: "gw-leases", namespace: "leases" });
    expect(p(gw.leaseRole).rules).toEqual([
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
    ]);
    expect(p(gw.leaseRoleBinding).roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "gw-leases" });
    expect(p(gw.leaseRoleBinding).subjects).toEqual([{ kind: "ServiceAccount", name: "gw-sa", namespace: "obs" }]);

    // Declared but left out of service.extensions: the collector never starts it, so no Role.
    const idle = OtelCollectorGateway({ config: [pipeline, elector, new CollectorService({ extensions: [] })] });
    expect(config(idle).extensions).toHaveProperty(["k8s_leader_elector"]);
    expect(idle.leaseRole).toBeUndefined();
    expect(OtelCollectorGateway({}).leaseRole).toBeUndefined();
  });

  test("k8s_leader_elector extensions in two lease namespaces get a Role and RoleBinding in each", () => {
    const a = new K8sLeaderElectorExtension({ name: "a", lease_name: "a", lease_namespace: "one" });
    const b = new K8sLeaderElectorExtension({ name: "b", lease_name: "b", lease_namespace: "team-two" });
    const debug = new DebugExporter({});
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const config = [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] }), new CollectorService({ extensions: [a, b] })];
    const gw = OtelCollectorGateway({ name: "gw", namespace: "obs", config });
    expect(p(gw.leaseRole).metadata).toMatchObject({ name: "gw-leases", namespace: "one" });
    expect(p(gw.leaseRoleBinding).metadata).toMatchObject({ name: "gw-leases", namespace: "one" });
    expect(p(gw.leaseRoleInTeamTwo).metadata).toMatchObject({ name: "gw-leases", namespace: "team-two" });
    expect(p(gw.leaseRoleInTeamTwo).rules).toEqual(p(gw.leaseRole).rules);
    expect(p(gw.leaseRoleBindingInTeamTwo).metadata).toMatchObject({ name: "gw-leases", namespace: "team-two" });
    expect(p(gw.leaseRoleBindingInTeamTwo).subjects).toEqual([{ kind: "ServiceAccount", name: "gw-sa", namespace: "obs" }]);
    const roles = manifests({ gw }).filter((d) => d.kind === "Role" || d.kind === "RoleBinding");
    expect(roles.map((d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`).sort()).toEqual([
      "Role/one/gw-leases",
      "Role/team-two/gw-leases",
      "RoleBinding/one/gw-leases",
      "RoleBinding/team-two/gw-leases",
    ]);
  });

  test("the Deployment and ConfigMap say they are a gateway and name each other", () => {
    const gw = OtelCollectorGateway({ name: "gw" });
    expect(p(gw.deployment).metadata.annotations).toEqual({ [A.role]: "gateway", [A.config]: "gw-config" });
    expect(p(gw.configMap).metadata.annotations).toEqual({ [A.role]: "gateway", [A.workload]: "Deployment/gw" });
    expect(p(gw.deployment).metadata.labels["app.kubernetes.io/component"]).toBe("gateway");
  });

  test("defaults override a member", () => {
    const gw = OtelCollectorGateway({ defaults: { deployment: { spec: { replicas: 5 } }, headlessService: { spec: { publishNotReadyAddresses: true } } } });
    expect(p(gw.deployment).spec.replicas).toBe(5);
    expect(p(gw.headlessService).spec.publishNotReadyAddresses).toBe(true);
  });
});

describe("gatewayExporter", () => {
  test("by default, an otlp exporter at the gateway's ClusterIP Service", () => {
    const exporter = gatewayExporter(OtelCollectorGateway({}));
    expect(exporter.componentId).toBe("otlp/gateway");
    expect(p(exporter)).toEqual({ name: "gateway", endpoint: "otel-gateway.observability.svc:4317", tls: { insecure: true } });
  });

  test("with loadBalance, a loadbalancing exporter on the headless Service through the k8s resolver", () => {
    const exporter = gatewayExporter(OtelCollectorGateway({}), { loadBalance: true });
    expect(exporter.componentId).toBe("loadbalancing/gateway");
    expect(p(exporter)).toEqual({
      name: "gateway",
      routing_key: "traceID",
      protocol: { otlp: { tls: { insecure: true } } },
      resolver: { k8s: { service: "otel-gateway-headless.observability", ports: [4317] } },
    });
  });

  test("the dns resolver resolves the headless Service's name", () => {
    const exporter = gatewayExporter(OtelCollectorGateway({}), { loadBalance: true, resolver: "dns" });
    expect(p(exporter).resolver).toEqual({ dns: { hostname: "otel-gateway-headless.observability.svc", port: "4317" } });
  });

  test.each([
    [{ name: "tail", namespace: "observability" }, "tail.observability.svc:4317", "tail-headless.observability"],
    [{ name: "otel-gateway", namespace: "telemetry" }, "otel-gateway.telemetry.svc:4317", "otel-gateway-headless.telemetry"],
    [{ name: "edge", namespace: "prod-obs" }, "edge.prod-obs.svc:4317", "edge-headless.prod-obs"],
  ])("renaming the gateway or moving its namespace moves the agent's endpoint (%o)", (props, endpoint, service) => {
    const gw = OtelCollectorGateway(props);
    const direct = config(agentOf(gatewayExporter(gw)));
    expect(direct.exporters?.["otlp/gateway"]).toMatchObject({ endpoint });
    const balanced = config(agentOf(gatewayExporter(gw, { loadBalance: true })));
    expect(balanced.exporters?.["loadbalancing/gateway"]).toMatchObject({ resolver: { k8s: { service } } });
  });

  test("the port follows the gateway's receiver", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:14317" } } });
    const gw = OtelCollectorGateway({ config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [new DebugExporter({})] })] });
    expect(p(gatewayExporter(gw)).endpoint).toBe("otel-gateway.observability.svc:14317");
    expect(p(gatewayExporter(gw, { loadBalance: true })).resolver.k8s.ports).toEqual([14317]);
  });

  test("a gateway without an OTLP gRPC port is refused with the ports it has", () => {
    const otlp = new OtlpReceiver({ protocols: { http: { endpoint: "0.0.0.0:4318" } } });
    const gw = OtelCollectorGateway({ config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [new DebugExporter({})] })] });
    expect(() => gatewayExporter(gw)).toThrow(/no port named "otlp-grpc" \(it has: otlp-http\)/);
  });

  test("with protocol http, an otlphttp exporter at the gateway's OTLP HTTP port", () => {
    const exporter = gatewayExporter(OtelCollectorGateway({}), { protocol: "http" });
    expect(exporter.componentId).toBe("otlphttp/gateway");
    expect(p(exporter)).toEqual({ name: "gateway", endpoint: "http://otel-gateway.observability.svc:4318" });
    const agent = agentOf(exporter, { name: "agent" });
    expect(config(agent).exporters?.["otlphttp/gateway"]).toEqual({ endpoint: "http://otel-gateway.observability.svc:4318" });
    expect(p(agent.configMap).metadata.annotations[A.gateways]).toBe("observability/otel-gateway=service");
    // agentOf's pipeline has no batch processor, which OTEL125 reports for an otlphttp exporter.
    expect(validateCollectorConfig(config(agent)).filter((i) => i.code !== "OTEL125")).toEqual([]);
  });

  test("with protocol http and TLS, https and the TLS settings without insecure", () => {
    const exporter = gatewayExporter(OtelCollectorGateway({ name: "gw", namespace: "obs" }), { protocol: "http", tls: { ca_file: "/certs/ca.pem" } });
    expect(p(exporter)).toEqual({ name: "gateway", endpoint: "https://gw.obs.svc:4318", tls: { ca_file: "/certs/ca.pem" } });
  });

  test("with protocol grpc, the default otlp exporter", () => {
    const gw = OtelCollectorGateway({});
    expect(p(gatewayExporter(gw, { protocol: "grpc" }))).toEqual(p(gatewayExporter(gw)));
  });

  test("protocol http with loadBalance is refused", () => {
    expect(() => gatewayExporter(OtelCollectorGateway({}), { protocol: "http", loadBalance: true })).toThrow(/gRPC only/);
  });

  test("a gateway without an OTLP HTTP port is refused for protocol http", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const gw = OtelCollectorGateway({ config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [new DebugExporter({})] })] });
    expect(() => gatewayExporter(gw, { protocol: "http" })).toThrow(/no port named "otlp-http" \(it has: otlp-grpc\)/);
  });

  test("the otel topology reports the gateway as the exporter's endpoint", () => {
    const agent = agentOf(gatewayExporter(OtelCollectorGateway({ namespace: "obs" }), { loadBalance: true }));
    const exporters = collectorTopology(config(agent)).exporters;
    expect(exporters.map((e: any) => e.endpoints)).toEqual([["otel-gateway-headless.obs:4317"]]);
  });
});

describe("OtelCollector wired to a gateway", () => {
  test("through loadbalancing with the k8s resolver: a Role in the gateway's namespace for the agent's ServiceAccount", () => {
    const gw = OtelCollectorGateway({ namespace: "gateways" });
    const agent = agentOf(gatewayExporter(gw, { loadBalance: true }), { name: "agent", namespace: "agents" });
    expect(p(agent.endpointsRole).metadata).toMatchObject({ name: "agent-endpoints", namespace: "gateways" });
    expect(p(agent.endpointsRole).rules).toEqual([
      { apiGroups: [""], resources: ["endpoints"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["get", "list", "watch"] },
    ]);
    expect(p(agent.endpointsRoleBinding).metadata.namespace).toBe("gateways");
    expect(p(agent.endpointsRoleBinding).roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "agent-endpoints" });
    expect(p(agent.endpointsRoleBinding).subjects).toEqual([{ kind: "ServiceAccount", name: "agent-sa", namespace: "agents" }]);
  });

  test("through the Service or the dns resolver: no Role", () => {
    const gw = OtelCollectorGateway({});
    expect(agentOf(gatewayExporter(gw)).endpointsRole).toBeUndefined();
    expect(agentOf(gatewayExporter(gw, { loadBalance: true, resolver: "dns" })).endpointsRole).toBeUndefined();
    expect(OtelCollector({}).endpointsRole).toBeUndefined();
  });

  test("a hand-written loadbalancing exporter with the k8s resolver gets the Role too", () => {
    const lb = new LoadBalancingExporter({ name: "gw", resolver: { k8s: { service: "gw-headless" } } });
    const agent = agentOf(lb, { namespace: "obs" });
    expect(p(agent.endpointsRole).metadata.namespace).toBe("obs");
    expect(p(agent.configMap).metadata.annotations[A.gateways]).toBeUndefined();
  });

  test("resolvers in two namespaces get a Role and RoleBinding in each", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const a = gatewayExporter(OtelCollectorGateway({ namespace: "one" }), { loadBalance: true, name: "a" });
    const b = gatewayExporter(OtelCollectorGateway({ namespace: "team-two" }), { loadBalance: true, name: "b" });
    const agent = OtelCollector({ name: "agent", namespace: "agents", config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [a, b] })] });
    expect(p(agent.endpointsRole).metadata).toMatchObject({ name: "agent-endpoints", namespace: "one" });
    expect(p(agent.endpointsRoleInTeamTwo).metadata).toMatchObject({ name: "agent-endpoints", namespace: "team-two" });
    expect(p(agent.endpointsRoleInTeamTwo).rules).toEqual(p(agent.endpointsRole).rules);
    for (const binding of [agent.endpointsRoleBinding, agent.endpointsRoleBindingInTeamTwo]) {
      expect(p(binding).roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "agent-endpoints" });
      expect(p(binding).subjects).toEqual([{ kind: "ServiceAccount", name: "agent-sa", namespace: "agents" }]);
    }
    expect(p(agent.endpointsRoleBindingInTeamTwo).metadata.namespace).toBe("team-two");
    const roles = manifests({ agent }).filter((d) => d.kind === "Role" || d.kind === "RoleBinding");
    expect(roles.map((d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`).sort()).toEqual([
      "Role/one/agent-endpoints",
      "Role/team-two/agent-endpoints",
      "RoleBinding/one/agent-endpoints",
      "RoleBinding/team-two/agent-endpoints",
    ]);
  });

  test("resolvers in one namespace keep a single Role", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const gw = OtelCollectorGateway({ namespace: "one" });
    const a = gatewayExporter(gw, { loadBalance: true, name: "a" });
    const b = gatewayExporter(gw, { loadBalance: true, name: "b", routingKey: "service" });
    const agent = OtelCollector({ config: [new Pipeline({ signal: "traces", receivers: [otlp], exporters: [a, b] })] });
    expect(Object.keys((agent as any).members).filter((k) => k.startsWith("endpoints")).sort()).toEqual(["endpointsRole", "endpointsRoleBinding"]);
  });

  test("the agent's ConfigMap and DaemonSet name the gateway and how they reach it", () => {
    const gw = OtelCollectorGateway({ name: "gw", namespace: "obs" });
    const balanced = agentOf(gatewayExporter(gw, { loadBalance: true }), { name: "agent" });
    expect(p(balanced.configMap).metadata.annotations).toEqual({
      [A.role]: "agent",
      [A.workload]: "DaemonSet/agent",
      [A.gateways]: "obs/gw=loadbalancing",
    });
    expect(p(balanced.daemonSet).metadata.annotations).toEqual({
      [A.role]: "agent",
      [A.config]: "agent-config",
      [A.gateways]: "obs/gw=loadbalancing",
    });
    const direct = agentOf(gatewayExporter(gw), { name: "agent" });
    expect(p(direct.configMap).metadata.annotations[A.gateways]).toBe("obs/gw=service");
  });

  test("an unwired agent says it is an agent and nothing more", () => {
    const agent = OtelCollector({});
    expect(p(agent.configMap).metadata.annotations).toEqual({ [A.role]: "agent", [A.workload]: "DaemonSet/otel-collector" });
  });
});

// What a post-synth check sees: only the built YAML. Starting from each
// collector ConfigMap, the annotations reach its workload and the gateway it
// sends to, with no knowledge of the composites.
describe("deployment shape in the built manifests", () => {
  test("a check can join each collector config to its workload, replicas and gateway routing", () => {
    const tail = new TailSamplingProcessor({
      decision_wait: "5s",
      policies: [{ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } }],
    });
    const gwOtlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const gateway = OtelCollectorGateway({
      replicas: 3,
      config: [new Pipeline({ signal: "traces", receivers: [gwOtlp], processors: [tail], exporters: [new DebugExporter({})] })],
    });
    const agent = agentOf(gatewayExporter(gateway, { loadBalance: true }), { name: "agent" });
    const docs = manifests({ gateway, agent });

    const find = (kind: string, ns: string, name: string) =>
      docs.find((d) => d.kind === kind && d.metadata.namespace === ns && d.metadata.name === name);

    const shapes = docs
      .filter((d) => d.kind === "ConfigMap" && d.metadata.annotations?.[A.role])
      .map((cm) => {
        const [kind, name] = cm.metadata.annotations[A.workload].split("/");
        const workload = find(kind, cm.metadata.namespace, name)!;
        expect(workload.metadata.annotations[A.config]).toBe(cm.metadata.name);
        const cfg = load(cm.data["config.yaml"]) as CollectorConfig;
        return {
          role: cm.metadata.annotations[A.role],
          kind: workload.kind,
          replicas: workload.spec.replicas,
          tailSampling: Object.keys(cfg.processors ?? {}).includes("tail_sampling"),
          gateways: cm.metadata.annotations[A.gateways],
        };
      });

    expect(shapes).toEqual([
      { role: "gateway", kind: "Deployment", replicas: 3, tailSampling: true, gateways: undefined },
      { role: "agent", kind: "DaemonSet", replicas: undefined, tailSampling: false, gateways: "observability/otel-gateway=loadbalancing" },
    ]);
    // The Role the k8s resolver needs is in the build, next to the gateway.
    expect(find("Role", "observability", "agent-endpoints")).toBeDefined();
  });
});
