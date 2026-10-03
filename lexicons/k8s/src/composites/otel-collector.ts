/**
 * OtelCollector composite: an OpenTelemetry Collector agent on any
 * Kubernetes cluster.
 *
 * A DaemonSet runs the collector on every node, with its config mounted from
 * a ConfigMap, and a Service with `internalTrafficPolicy: Local` sends each
 * pod's OTLP traffic to the collector on its own node. The config is declared
 * with the otel lexicon (`@intentius/chant-lexicon-otel`) and rendered with
 * `collectorYaml`. The container ports, the Service ports and the probes are
 * read back from that config, so they follow whatever config is passed in.
 *
 * `GkeOtelCollector` builds the same DaemonSet, RBAC and ConfigMap for GKE.
 * `OtelCollectorGateway` is the central tier agents export to; give this
 * composite an exporter from `gatewayExporter()` to point it there.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  otlpCollector,
  COLLECTOR_IMAGE,
  type OTelComponent,
  type Signal,
} from "@intentius/chant-lexicon-otel";
import { Service, Role, RoleBinding } from "../generated";
import { collectorAgentResources, type CollectorAgentResources, type CollectorLogAccess } from "./otel-collector-agent";
import { collectorNodeAccess } from "./otel-collector-node";
import { agentClusterRules, namespacedRoles } from "./otel-collector-rbac";
import {
  collectorRuntime,
  gatewaysAnnotation,
  gatewayTargetsOf,
  k8sResolverNamespaces,
  OTEL_COLLECTOR_ANNOTATIONS,
} from "./otel-collector-shape";

export interface OtelCollectorProps {
  /** Agent name (default: "otel-collector"). */
  name?: string;
  /** Namespace (default: "observability"). */
  namespace?: string;
  /** Collector image (default: the contrib image at the otel lexicon's pinned collector version). */
  image?: string;
  /**
   * The collector config, as otel lexicon entities (components and
   * pipelines). Replaces the default config, and `exporters` and `signals`
   * are then ignored.
   */
  config?: Iterable<Declarable>;
  /** Exporters for the default config (default: one `debug` exporter). */
  exporters?: OTelComponent<"exporter", string, any>[];
  /** Signals the default config has pipelines for (default: traces, metrics and logs). */
  signals?: Signal[];
  /** Additional labels. */
  labels?: Record<string, string>;
  /**
   * How a config with a `filelog` receiver reads the node's container logs,
   * which are root's: `group` (default) keeps user 10001 and adds the pod to
   * group 0, enough where the runtime writes them group-readable
   * (containerd); `root` runs the container as user 0. Ignored when the
   * config reads no logs from the node.
   */
  logAccess?: CollectorLogAccess;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "256Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "512Mi"). */
  memoryLimit?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
    endpointsRole?: Partial<Record<string, unknown>>;
    endpointsRoleBinding?: Partial<Record<string, unknown>>;
  };
}

export type OtelCollectorResult = CollectorAgentResources & {
  service: InstanceType<typeof Service>;
  /**
   * Read access to Endpoints for a `loadbalancing` exporter's `k8s` resolver,
   * in the first namespace the resolvers point at. Each further namespace
   * gets `endpointsRoleIn<Namespace>` and `endpointsRoleBindingIn<Namespace>`.
   */
  endpointsRole?: InstanceType<typeof Role>;
  endpointsRoleBinding?: InstanceType<typeof RoleBinding>;
  [member: `endpointsRoleIn${string}`]: InstanceType<typeof Role>;
  [member: `endpointsRoleBindingIn${string}`]: InstanceType<typeof RoleBinding>;
};

/**
 * Create an OtelCollector composite. Returns a DaemonSet, Service,
 * ServiceAccount, ClusterRole, ClusterRoleBinding and ConfigMap.
 *
 * @example
 * ```ts
 * import { OtelCollector } from "@intentius/chant-lexicon-k8s";
 * import { OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * export const collector = OtelCollector({
 *   exporters: [new OtlpExporter({ endpoint: "tempo.observability.svc:4317", tls: { insecure: true } })],
 * });
 * ```
 */
export const OtelCollector = Composite((props: OtelCollectorProps) => {
  const {
    name = "otel-collector",
    namespace = "observability",
    image = COLLECTOR_IMAGE,
    labels: extraLabels = {},
    logAccess = "group",
    cpuRequest = "100m",
    memoryRequest = "256Mi",
    cpuLimit = "500m",
    memoryLimit = "512Mi",
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const entities = props.config ? [...props.config] : otlpCollector({ exporters: props.exporters, signals: props.signals });
  const runtime = collectorRuntime(entities);
  const configMapName = `${name}-config`;

  // How this agent is deployed, and which gateways it sends to, recorded on
  // the ConfigMap and the DaemonSet for post-synth checks (see
  // OTEL_COLLECTOR_ANNOTATIONS).
  const gateways = gatewayTargetsOf(runtime.built);
  const shape: Record<string, string> = gateways.length ? { [OTEL_COLLECTOR_ANNOTATIONS.gateways]: gatewaysAnnotation(gateways) } : {};

  const resources = collectorAgentResources({
    name,
    namespace,
    image,
    commonLabels,
    extraLabels,
    configYaml: runtime.configYaml,
    configDir: runtime.configDir,
    ports: runtime.containerPorts,
    clusterRules: agentClusterRules(runtime.built.config),
    // The node name, host mounts and log access the config's node-reading
    // components need (#3103); nothing for a config that reads no node.
    nodeAccess: collectorNodeAccess(runtime.built.config, runtime.configDir),
    logAccess,
    cpuRequest,
    memoryRequest,
    cpuLimit,
    memoryLimit,
    containerExtra: runtime.containerExtra,
    workloadAnnotations: {
      [OTEL_COLLECTOR_ANNOTATIONS.role]: "agent",
      [OTEL_COLLECTOR_ANNOTATIONS.config]: configMapName,
      ...shape,
    },
    configMapAnnotations: {
      [OTEL_COLLECTOR_ANNOTATIONS.role]: "agent",
      [OTEL_COLLECTOR_ANNOTATIONS.workload]: `DaemonSet/${name}`,
      ...shape,
    },
    defaults: defs,
  });

  const service = new Service(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      internalTrafficPolicy: "Local",
      ports: runtime.servicePorts.map((p) => ({ name: p.name, port: p.port, targetPort: p.name, protocol: p.protocol ?? "TCP" })),
    },
  }, defs?.service));

  // The loadbalancing exporter's k8s resolver runs in this agent and watches
  // the gateway's headless Service, so the agent's ServiceAccount gets read
  // access to Endpoints (what the resolver watches at the pinned collector
  // version) and EndpointSlices (what later versions watch), with one Role
  // and RoleBinding in each namespace the resolvers point at.
  const saName = (resources.serviceAccount as unknown as { props: { metadata: { name: string } } }).props.metadata.name;
  const endpointsRbac = namespacedRoles({
    key: "endpoints",
    name: `${name}-endpoints`,
    namespaces: k8sResolverNamespaces(runtime.built, namespace),
    rules: [
      { apiGroups: [""], resources: ["endpoints"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["get", "list", "watch"] },
    ],
    labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    serviceAccount: { name: saName, namespace },
    roleDefaults: defs?.endpointsRole,
    roleBindingDefaults: defs?.endpointsRoleBinding,
  });

  return { ...resources, service, ...endpointsRbac } as OtelCollectorResult;
}, "OtelCollector");
