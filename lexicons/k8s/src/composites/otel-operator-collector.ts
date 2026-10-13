/**
 * OtelOperatorCollector composite: an OpenTelemetry Collector run by the
 * OpenTelemetry Operator, as an `OpenTelemetryCollector` custom resource
 * (opentelemetry.io/v1beta1).
 *
 * `OtelCollector` builds the DaemonSet, ConfigMap and Service itself. Here the
 * operator builds them from one custom resource, and the otel lexicon's
 * config goes straight into `spec.config`, which v1beta1 declares as an
 * object (`exporters`, `receivers` and `service` required). The ports, the
 * node access (downward API variables, host mounts, log group) and the RBAC
 * come from the same readers `OtelCollector` uses, so the two follow a config
 * the same way.
 *
 * An object has no comment lines, so the `# chant:` header that carries
 * custom-component pins and semconv use (see `buildCollectorConfig`) is kept
 * in the `otel.chant.dev/header` annotation, one line per entry. `chant
 * import` puts it back on top of the config when it reads the CR.
 *
 * The operator names the workload `<name>-collector` and, with
 * `spec.serviceAccount` set as it is here, runs it as the ServiceAccount this
 * composite makes. The ClusterRole is bound to that ServiceAccount.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  otlpCollector,
  COLLECTOR_IMAGE,
  type OTelComponent,
  type Signal,
} from "@intentius/chant-lexicon-otel";
import { ServiceAccount, ClusterRole, ClusterRoleBinding, Role, RoleBinding, OpenTelemetryCollector } from "../generated";
import type { MemberDefaults } from "./member-defaults";
import type { CollectorLogAccess } from "./otel-collector-agent";
import { collectorNodeAccess, nodeVolumeMounts, nodeVolumes } from "./otel-collector-node";
import { agentClusterRules, namespacedRoles } from "./otel-collector-rbac";
import {
  collectorRuntime,
  gatewaysAnnotation,
  gatewayTargetsOf,
  k8sResolverNamespaces,
  OTEL_COLLECTOR_ANNOTATIONS,
} from "./otel-collector-shape";

/** How the operator runs the collector. `sidecar` is left out: it injects into other pods, which this composite does not name. */
export type OtelOperatorMode = "daemonset" | "deployment" | "statefulset";

export interface OtelOperatorCollectorProps {
  /** Custom resource name (default: "otel-collector"). The operator names the workload `<name>-collector`. */
  name?: string;
  /** Namespace (default: "observability"). */
  namespace?: string;
  /** How the operator runs it (default: "daemonset", the agent shape `OtelCollector` has). */
  mode?: OtelOperatorMode;
  /** Replica count for `deployment` and `statefulset` (left to the operator's default of 1 when unset). Not allowed for `daemonset`. */
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
  /** Additional labels. */
  labels?: Record<string, string>;
  /** How a config with a `filelog` receiver reads the node's container logs; see `OtelCollector`. Ignored for a config that reads no logs from the node. */
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
    collector?: MemberDefaults<"OpenTelemetryCollector">;
    serviceAccount?: MemberDefaults<"ServiceAccount">;
    clusterRole?: MemberDefaults<"ClusterRole">;
    clusterRoleBinding?: MemberDefaults<"ClusterRoleBinding">;
    endpointsRole?: MemberDefaults<"Role">;
    endpointsRoleBinding?: MemberDefaults<"RoleBinding">;
  };
}

export type OtelOperatorCollectorResult = {
  collector: InstanceType<typeof OpenTelemetryCollector>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  /** Read access to Endpoints for a `loadbalancing` exporter's `k8s` resolver, as in `OtelCollectorResult`. */
  endpointsRole?: InstanceType<typeof Role>;
  endpointsRoleBinding?: InstanceType<typeof RoleBinding>;
  [member: `endpointsRoleIn${string}`]: InstanceType<typeof Role>;
  [member: `endpointsRoleBindingIn${string}`]: InstanceType<typeof RoleBinding>;
};

/**
 * Create an OtelOperatorCollector composite. Returns an OpenTelemetryCollector
 * custom resource, a ServiceAccount, a ClusterRole and a ClusterRoleBinding.
 *
 * @example
 * ```ts
 * import { OtelOperatorCollector } from "@intentius/chant-lexicon-k8s";
 * import { OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * export const collector = OtelOperatorCollector({
 *   mode: "deployment",
 *   replicas: 2,
 *   exporters: [new OtlpExporter({ endpoint: "tempo.observability.svc:4317", tls: { insecure: true } })],
 * });
 * ```
 */
export const OtelOperatorCollector = Composite((props: OtelOperatorCollectorProps) => {
  const {
    name = "otel-collector",
    namespace = "observability",
    mode = "daemonset",
    image = COLLECTOR_IMAGE,
    labels: extraLabels = {},
    logAccess = "group",
    cpuRequest = "100m",
    memoryRequest = "256Mi",
    cpuLimit = "500m",
    memoryLimit = "512Mi",
    defaults: defs,
  } = props;

  if (mode === "daemonset" && props.replicas !== undefined) {
    throw new Error(`${name}: a daemonset runs one collector per node, so replicas does not apply`);
  }

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const entities = props.config ? [...props.config] : otlpCollector({ exporters: props.exporters, signals: props.signals });
  const runtime = collectorRuntime(entities);
  const gateways = gatewayTargetsOf(runtime.built);
  const saName = `${name}-sa`;

  const access = collectorNodeAccess(runtime.built.config, runtime.configDir);
  const asRoot = access.readsLogs && logAccess === "root";
  const container = runtime.containerExtra.securityContext as Record<string, unknown>;

  const annotations: Record<string, string> = {
    [OTEL_COLLECTOR_ANNOTATIONS.role]: mode === "daemonset" ? "agent" : "gateway",
    ...(gateways.length ? { [OTEL_COLLECTOR_ANNOTATIONS.gateways]: gatewaysAnnotation(gateways) } : {}),
    ...(runtime.built.header.length ? { [OTEL_COLLECTOR_ANNOTATIONS.header]: runtime.built.header.join("\n") } : {}),
  };

  const collector = new OpenTelemetryCollector(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": mode === "daemonset" ? "agent" : "gateway" },
      annotations,
    },
    spec: {
      mode,
      ...(props.replicas !== undefined ? { replicas: props.replicas } : {}),
      image,
      serviceAccount: saName,
      config: runtime.built.config,
      ports: runtime.servicePorts.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol ?? "TCP" })),
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuLimit, memory: memoryLimit },
      },
      securityContext: asRoot ? { ...container, runAsNonRoot: false, runAsUser: 0 } : container,
      ...(access.readsLogs && !asRoot ? { podSecurityContext: { supplementalGroups: [0] } } : {}),
      ...(access.env.length ? { env: access.env } : {}),
      ...(access.mounts.length ? { volumes: nodeVolumes(access.mounts), volumeMounts: nodeVolumeMounts(access.mounts) } : {}),
      ...(mode === "daemonset" ? { tolerations: [{ operator: "Exists" }] } : {}),
    },
  }, defs?.collector));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
  }, defs?.serviceAccount));

  const clusterRoleName = `${name}-role`;
  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: { name: clusterRoleName, labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" } },
    rules: agentClusterRules(runtime.built.config),
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: { name: `${name}-binding`, labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" } },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRoleName },
    subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
  }, defs?.clusterRoleBinding));

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

  return { collector, serviceAccount, clusterRole, clusterRoleBinding, ...endpointsRbac } as OtelOperatorCollectorResult;
}, "OtelOperatorCollector");
