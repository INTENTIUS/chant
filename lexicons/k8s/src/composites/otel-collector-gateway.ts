/**
 * OtelCollectorGateway composite: an OpenTelemetry Collector gateway, the
 * central tier that per-node agents export to.
 *
 * A Deployment runs the collector with `replicas` pods, its config mounted
 * from a ConfigMap. A ClusterIP Service takes the agents' OTLP traffic, and a
 * headless Service lists the individual pods, which is what the agents'
 * `loadbalancing` exporter resolves when every span of a trace has to reach
 * the same replica (tail sampling, spanmetrics). The config is declared with
 * the otel lexicon; ports and probes are read back from it, as `OtelCollector`
 * does.
 *
 * `gatewayExporter()` builds the agent side: an exporter whose endpoint comes
 * from this composite's Services, so renaming the gateway or moving it to
 * another namespace moves the agents with it.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  otlpCollector,
  LoadBalancingExporter,
  OtlpExporter,
  COLLECTOR_IMAGE,
  type LoadBalancingRoutingKey,
  type OTelComponent,
  type Signal,
  type TLSClientSettings,
} from "@intentius/chant-lexicon-otel";
import {
  Deployment,
  Service,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
  PodDisruptionBudget,
  Role,
  RoleBinding,
} from "../generated";
import { collectorConfigMap, collectorContainer } from "./otel-collector-agent";
import {
  collectorRuntime,
  leaderElectorLeaseNamespaces,
  markGatewayExporter,
  OTEL_COLLECTOR_ANNOTATIONS,
  type GatewayRouting,
} from "./otel-collector-shape";

/** One RBAC rule, as a ClusterRole lists it. */
export interface CollectorPolicyRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

export interface OtelCollectorGatewayProps {
  /** Gateway name (default: "otel-gateway"). */
  name?: string;
  /** Namespace (default: "observability"). */
  namespace?: string;
  /** Number of collector pods (default: 2). */
  replicas?: number;
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
  /**
   * Cluster-wide read access the config needs, e.g. for a `k8s_cluster`
   * receiver or a `k8sattributes` processor. When given, the composite adds a
   * ClusterRole with these rules bound to the gateway's ServiceAccount.
   * Default: none.
   */
  clusterRules?: CollectorPolicyRule[];
  /** Additional labels. */
  labels?: Record<string, string>;
  /** CPU request (default: "200m"). */
  cpuRequest?: string;
  /** Memory request (default: "512Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "1"). */
  cpuLimit?: string;
  /** Memory limit (default: "1Gi"). */
  memoryLimit?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    headlessService?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
    podDisruptionBudget?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    leaseRole?: Partial<Record<string, unknown>>;
    leaseRoleBinding?: Partial<Record<string, unknown>>;
  };
}

export type OtelCollectorGatewayResult = {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  headlessService: InstanceType<typeof Service>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  configMap: InstanceType<typeof ConfigMap>;
  /** With more than one replica: at most one pod down at a time during voluntary disruptions. */
  podDisruptionBudget?: InstanceType<typeof PodDisruptionBudget>;
  clusterRole?: InstanceType<typeof ClusterRole>;
  clusterRoleBinding?: InstanceType<typeof ClusterRoleBinding>;
  /** Access to Leases for a `k8s_leader_elector` extension the config enables, in the Lease's namespace. */
  leaseRole?: InstanceType<typeof Role>;
  leaseRoleBinding?: InstanceType<typeof RoleBinding>;
};

/**
 * Create an OtelCollectorGateway composite. Returns a Deployment, a ClusterIP
 * Service, a headless Service, a ServiceAccount and a ConfigMap, a
 * PodDisruptionBudget when there is more than one replica, a ClusterRole
 * and binding when `clusterRules` is set, and a Role and binding for Leases
 * when the config enables a `k8s_leader_elector` extension.
 *
 * @example
 * ```ts
 * import { OtelCollector, OtelCollectorGateway, gatewayExporter } from "@intentius/chant-lexicon-k8s";
 *
 * export const gateway = OtelCollectorGateway({ replicas: 3 });
 * export const agent = OtelCollector({ exporters: [gatewayExporter(gateway, { loadBalance: true })], signals: ["traces"] });
 * ```
 */
export const OtelCollectorGateway = Composite((props: OtelCollectorGatewayProps) => {
  const {
    name = "otel-gateway",
    namespace = "observability",
    replicas = 2,
    image = COLLECTOR_IMAGE,
    labels: extraLabels = {},
    cpuRequest = "200m",
    memoryRequest = "512Mi",
    cpuLimit = "1",
    memoryLimit = "1Gi",
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };
  const gatewayLabels = { ...commonLabels, "app.kubernetes.io/component": "gateway" };
  const saName = `${name}-sa`;
  const configMapName = `${name}-config`;

  const entities = props.config ? [...props.config] : otlpCollector({ exporters: props.exporters, signals: props.signals });
  const runtime = collectorRuntime(entities);

  const container = collectorContainer({
    name,
    image,
    configDir: runtime.configDir,
    ports: runtime.containerPorts,
    cpuRequest,
    memoryRequest,
    cpuLimit,
    memoryLimit,
    containerExtra: runtime.containerExtra,
  });

  const deployment = new Deployment(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: gatewayLabels,
      annotations: {
        [OTEL_COLLECTOR_ANNOTATIONS.role]: "gateway",
        [OTEL_COLLECTOR_ANNOTATIONS.config]: configMapName,
      },
    },
    spec: {
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, "app.kubernetes.io/component": "gateway", ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [container],
          volumes: [{ name: "config", configMap: { name: configMapName } }],
        },
      },
    },
  }, defs?.deployment));

  const servicePorts = runtime.servicePorts.map((p) => ({ name: p.name, port: p.port, targetPort: p.name, protocol: "TCP" }));

  const service = new Service(mergeDefaults({
    metadata: { name, namespace, labels: gatewayLabels },
    spec: {
      type: "ClusterIP",
      selector: { "app.kubernetes.io/name": name },
      ports: servicePorts,
    },
  }, defs?.service));

  // A headless Service's DNS name and Endpoints list every ready pod, which is
  // what the agents' loadbalancing exporter hashes traces across.
  const headlessService = new Service(mergeDefaults({
    metadata: { name: `${name}-headless`, namespace, labels: gatewayLabels },
    spec: {
      clusterIP: "None",
      selector: { "app.kubernetes.io/name": name },
      ports: servicePorts,
    },
  }, defs?.headlessService));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: { name: saName, namespace, labels: gatewayLabels },
  }, defs?.serviceAccount));

  const configMap = collectorConfigMap(
    { namespace, commonLabels, configYaml: runtime.configYaml, defaults: defs },
    configMapName,
    {
      [OTEL_COLLECTOR_ANNOTATIONS.role]: "gateway",
      [OTEL_COLLECTOR_ANNOTATIONS.workload]: `Deployment/${name}`,
    },
  );

  const pdb = replicas > 1
    ? {
        podDisruptionBudget: new PodDisruptionBudget(mergeDefaults({
          metadata: { name, namespace, labels: gatewayLabels },
          spec: { maxUnavailable: 1, selector: { matchLabels: { "app.kubernetes.io/name": name } } },
        }, defs?.podDisruptionBudget)),
      }
    : {};

  const rbac = props.clusterRules?.length
    ? {
        clusterRole: new ClusterRole(mergeDefaults({
          metadata: { name: `${name}-role`, labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" } },
          rules: props.clusterRules,
        }, defs?.clusterRole)),
        clusterRoleBinding: new ClusterRoleBinding(mergeDefaults({
          metadata: { name: `${name}-binding`, labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" } },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: `${name}-role` },
          subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
        }, defs?.clusterRoleBinding)),
      }
    : {};

  // A k8s_leader_elector extension takes a Lease in its lease_namespace, so
  // the gateway's ServiceAccount gets the access the extension's README
  // suggests (collector-contrib v0.130.0, extension/k8sleaderelector).
  const leaseNamespaces = leaderElectorLeaseNamespaces(runtime.built);
  if (leaseNamespaces.length > 1) {
    throw new Error(
      `OtelCollectorGateway ${name}: k8s_leader_elector extensions take Leases in ${leaseNamespaces.join(" and ")}; ` +
        `the gateway grants Lease access in one namespace. Use one lease_namespace, or grant the rest through clusterRules`,
    );
  }
  const leaseRbac = leaseNamespaces.length
    ? {
        leaseRole: new Role(mergeDefaults({
          metadata: {
            name: `${name}-leases`,
            namespace: leaseNamespaces[0],
            labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
          },
          rules: [
            {
              apiGroups: ["coordination.k8s.io"],
              resources: ["leases"],
              verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
            },
          ],
        }, defs?.leaseRole)),
        leaseRoleBinding: new RoleBinding(mergeDefaults({
          metadata: {
            name: `${name}-leases`,
            namespace: leaseNamespaces[0],
            labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
          },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: `${name}-leases` },
          subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
        }, defs?.leaseRoleBinding)),
      }
    : {};

  return { deployment, service, headlessService, serviceAccount, configMap, ...pdb, ...rbac, ...leaseRbac };
}, "OtelCollectorGateway");

// ── Agent side ───────────────────────────────────────────────────────

export interface GatewayExporterOptions {
  /** Exporter name, so the id is `otlp/<name>` or `loadbalancing/<name>` (default: "gateway"). */
  name?: string;
  /**
   * Send each trace to one gateway replica through the headless Service with
   * a `loadbalancing` exporter, instead of to the ClusterIP Service with an
   * `otlp` exporter. Needed in front of a multi-replica gateway that runs
   * `tail_sampling` or `spanmetrics`. Default: false.
   */
  loadBalance?: boolean;
  /**
   * How the `loadbalancing` exporter finds the replicas: `k8s` watches the
   * headless Service's Endpoints (the agent composite then adds the RBAC for
   * it), `dns` resolves its name. Default: "k8s".
   */
  resolver?: "k8s" | "dns";
  /** What the `loadbalancing` exporter hashes on (default: "traceID"). */
  routingKey?: LoadBalancingRoutingKey;
  /** The gateway Service port to send to, by name (default: "otlp-grpc"). */
  port?: string;
  /** TLS for the connection to the gateway (default: `{ insecure: true }`, plaintext inside the cluster). */
  tls?: TLSClientSettings;
}

interface ServiceMeta {
  name: string;
  namespace: string;
  ports: Array<{ name?: string; port: number }>;
}

function serviceMeta(service: InstanceType<typeof Service>): ServiceMeta {
  const p = (service as unknown as { props: { metadata: { name: string; namespace: string }; spec: { ports?: ServiceMeta["ports"] } } }).props;
  return { name: p.metadata.name, namespace: p.metadata.namespace, ports: p.spec.ports ?? [] };
}

/**
 * The exporter an agent uses to send to a gateway, built from the gateway's
 * own declaration: its Services' names, its namespace, and the port its
 * config listens on.
 *
 * By default an `otlp` exporter at `<service>.<namespace>.svc:<port>`. With
 * `loadBalance`, a `loadbalancing` exporter routing by trace id to the
 * headless Service, through the `k8s` resolver (`<headless>.<namespace>`) or
 * the `dns` resolver (`<headless>.<namespace>.svc`). Put it in the agent's
 * pipelines like any other exporter; `OtelCollector` records the link in its
 * annotations and adds the RBAC the `k8s` resolver needs.
 */
export function gatewayExporter(
  gateway: OtelCollectorGatewayResult,
  options: GatewayExporterOptions = {},
): InstanceType<typeof OtlpExporter> | InstanceType<typeof LoadBalancingExporter> {
  const { name = "gateway", loadBalance = false, resolver = "k8s", routingKey = "traceID", port: portName = "otlp-grpc", tls = { insecure: true } } = options;
  const deploymentName = (gateway.deployment as unknown as { props: { metadata: { name: string } } }).props.metadata.name;
  const target = serviceMeta(loadBalance ? gateway.headlessService : gateway.service);
  const port = target.ports.find((p) => p.name === portName)?.port;
  if (port === undefined) {
    const names = target.ports.map((p) => p.name).join(", ") || "none";
    throw new Error(
      `gatewayExporter: Service ${target.namespace}/${target.name} has no port named "${portName}" (it has: ${names}); ` +
        `give the gateway an OTLP gRPC receiver or pass the port name`,
    );
  }
  const routing: GatewayRouting = loadBalance ? "loadbalancing" : "service";

  const exporter = loadBalance
    ? new LoadBalancingExporter({
        name,
        routing_key: routingKey,
        protocol: { otlp: { tls } },
        resolver:
          resolver === "dns"
            ? { dns: { hostname: `${target.name}.${target.namespace}.svc`, port: String(port) } }
            : { k8s: { service: `${target.name}.${target.namespace}`, ports: [port] } },
      })
    : new OtlpExporter({ name, endpoint: `${target.name}.${target.namespace}.svc:${port}`, tls });

  markGatewayExporter(exporter, { name: deploymentName, namespace: target.namespace, routing });
  return exporter;
}
