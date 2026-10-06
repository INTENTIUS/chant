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
  OtlpHttpExporter,
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
import type { MemberDefaults } from "./member-defaults";
import { collectorConfigMap, collectorContainer } from "./otel-collector-agent";
import { namespacedRoles, type CollectorPolicyRule } from "./otel-collector-rbac";
import {
  collectorRuntime,
  leaderElectorLeaseNamespaces,
  markGatewayExporter,
  OTEL_COLLECTOR_ANNOTATIONS,
  type GatewayRouting,
} from "./otel-collector-shape";

export type { CollectorPolicyRule };

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
    deployment?: MemberDefaults<"Deployment">;
    service?: MemberDefaults<"Service">;
    headlessService?: MemberDefaults<"Service">;
    serviceAccount?: MemberDefaults<"ServiceAccount">;
    configMap?: MemberDefaults<"ConfigMap">;
    podDisruptionBudget?: MemberDefaults<"PodDisruptionBudget">;
    clusterRole?: MemberDefaults<"ClusterRole">;
    clusterRoleBinding?: MemberDefaults<"ClusterRoleBinding">;
    leaseRole?: MemberDefaults<"Role">;
    leaseRoleBinding?: MemberDefaults<"RoleBinding">;
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
  /**
   * Access to Leases for the `k8s_leader_elector` extensions the config
   * enables, in the first `lease_namespace`. Each further namespace gets
   * `leaseRoleIn<Namespace>` and `leaseRoleBindingIn<Namespace>`.
   */
  leaseRole?: InstanceType<typeof Role>;
  leaseRoleBinding?: InstanceType<typeof RoleBinding>;
  [member: `leaseRoleIn${string}`]: InstanceType<typeof Role>;
  [member: `leaseRoleBindingIn${string}`]: InstanceType<typeof RoleBinding>;
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

  const servicePorts = runtime.servicePorts.map((p) => ({ name: p.name, port: p.port, targetPort: p.name, protocol: p.protocol ?? "TCP" }));

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
  // suggests (collector-contrib v0.130.0, extension/k8sleaderelector), with
  // one Role and RoleBinding in each namespace the electors use.
  const leaseRbac = namespacedRoles({
    key: "lease",
    name: `${name}-leases`,
    namespaces: leaderElectorLeaseNamespaces(runtime.built),
    rules: [
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
    ],
    labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    serviceAccount: { name: saName, namespace },
    roleDefaults: defs?.leaseRole,
    roleBindingDefaults: defs?.leaseRoleBinding,
  });

  return { deployment, service, headlessService, serviceAccount, configMap, ...pdb, ...rbac, ...leaseRbac } as OtelCollectorGatewayResult;
}, "OtelCollectorGateway");

// ── Agent side ───────────────────────────────────────────────────────

export interface GatewayExporterOptions {
  /** Exporter name, so the id is `otlp/<name>`, `otlphttp/<name>` or `loadbalancing/<name>` (default: "gateway"). */
  name?: string;
  /**
   * OTLP over gRPC (an `otlp` exporter) or over HTTP (an `otlphttp`
   * exporter). The `loadbalancing` exporter sends OTLP over gRPC only at the
   * pinned collector version, so `http` cannot be combined with
   * `loadBalance`. Default: "grpc".
   */
  protocol?: "grpc" | "http";
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
  /** The gateway Service port to send to, by name (default: "otlp-grpc", or "otlp-http" with `protocol: "http"`). */
  port?: string;
  /**
   * TLS for the connection to the gateway (default: `{ insecure: true }`,
   * plaintext inside the cluster). Over HTTP, `insecure` picks the scheme
   * (`http://`, or `https://` without it) and the other settings are passed on.
   */
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
 * `protocol: "http"`, an `otlphttp` exporter at
 * `http://<service>.<namespace>.svc:<port>` (`https://` when `tls` is not
 * `insecure`), sending to the gateway's OTLP HTTP port. With
 * `loadBalance`, a `loadbalancing` exporter routing by trace id to the
 * headless Service, through the `k8s` resolver (`<headless>.<namespace>`) or
 * the `dns` resolver (`<headless>.<namespace>.svc`). Put it in the agent's
 * pipelines like any other exporter; `OtelCollector` records the link in its
 * annotations and adds the RBAC the `k8s` resolver needs.
 */
export function gatewayExporter(
  gateway: OtelCollectorGatewayResult,
  options: GatewayExporterOptions = {},
): InstanceType<typeof OtlpExporter> | InstanceType<typeof OtlpHttpExporter> | InstanceType<typeof LoadBalancingExporter> {
  const { name = "gateway", protocol = "grpc", loadBalance = false, resolver = "k8s", routingKey = "traceID", tls = { insecure: true } } = options;
  const portName = options.port ?? (protocol === "http" ? "otlp-http" : "otlp-grpc");
  if (protocol === "http" && loadBalance) {
    throw new Error(
      `gatewayExporter: the loadbalancing exporter sends OTLP over gRPC only; ` +
        `use protocol "grpc" with loadBalance, or drop loadBalance to send OTLP over HTTP to the gateway's Service`,
    );
  }
  const deploymentName = (gateway.deployment as unknown as { props: { metadata: { name: string } } }).props.metadata.name;
  const target = serviceMeta(loadBalance ? gateway.headlessService : gateway.service);
  const port = target.ports.find((p) => p.name === portName)?.port;
  if (port === undefined) {
    const names = target.ports.map((p) => p.name).join(", ") || "none";
    throw new Error(
      `gatewayExporter: Service ${target.namespace}/${target.name} has no port named "${portName}" (it has: ${names}); ` +
        `give the gateway an OTLP ${protocol === "http" ? "HTTP" : "gRPC"} receiver or pass the port name`,
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
    : protocol === "http"
      ? otlpHttpExporter(name, `${target.name}.${target.namespace}.svc:${port}`, tls)
      : new OtlpExporter({ name, endpoint: `${target.name}.${target.namespace}.svc:${port}`, tls });

  markGatewayExporter(exporter, { name: deploymentName, namespace: target.namespace, routing });
  return exporter;
}

/**
 * An `otlphttp` exporter to `host:port`. Its endpoint is a URL, so TLS is the
 * scheme: `insecure` gives `http://`, anything else `https://` with the
 * remaining TLS settings (a CA, a client certificate) kept.
 */
function otlpHttpExporter(name: string, hostPort: string, tls: TLSClientSettings): InstanceType<typeof OtlpHttpExporter> {
  const { insecure, ...rest } = tls;
  const scheme = insecure ? "http" : "https";
  return new OtlpHttpExporter({
    name,
    endpoint: `${scheme}://${hostPort}`,
    ...(Object.keys(rest).length ? { tls: rest } : {}),
  });
}
