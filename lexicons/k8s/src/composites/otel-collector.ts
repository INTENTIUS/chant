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
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  buildCollectorConfig,
  collectorEndpoints,
  collectorYaml,
  otlpCollector,
  COLLECTOR_CONFIG_PATH,
  COLLECTOR_IMAGE,
  type OTelComponent,
  type Signal,
} from "@intentius/chant-lexicon-otel";
import { Service } from "../generated";
import { collectorAgentResources, type CollectorAgentResources } from "./otel-collector-agent";

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
  };
}

export type OtelCollectorResult = CollectorAgentResources & {
  service: InstanceType<typeof Service>;
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
  const { ports, healthCheck } = collectorEndpoints(buildCollectorConfig(entities).config);
  const configDir = COLLECTOR_CONFIG_PATH.slice(0, COLLECTOR_CONFIG_PATH.lastIndexOf("/"));

  // The probe names the port. A health_check on a receiver's port reuses that
  // port's name, since a container port is declared once.
  const healthPortName = healthCheck ? (ports.find((p) => p.port === healthCheck.port)?.name ?? "health") : undefined;
  const probe = healthCheck ? { httpGet: { path: healthCheck.path, port: healthPortName } } : undefined;
  const containerPorts = [
    ...ports.map((p) => ({ containerPort: p.port, name: p.name })),
    ...(healthCheck && !ports.some((p) => p.port === healthCheck.port)
      ? [{ containerPort: healthCheck.port, name: "health" }]
      : []),
  ];

  const resources = collectorAgentResources({
    name,
    namespace,
    image,
    commonLabels,
    extraLabels,
    configYaml: collectorYaml(entities),
    configDir,
    ports: containerPorts,
    cpuRequest,
    memoryRequest,
    cpuLimit,
    memoryLimit,
    containerExtra: {
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      },
      ...(probe ? { livenessProbe: probe, readinessProbe: probe } : {}),
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
      ports: ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.name, protocol: "TCP" })),
    },
  }, defs?.service));

  return { ...resources, service };
}, "OtelCollector");
