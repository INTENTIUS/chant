/**
 * What `OtelCollector` and `OtelCollectorGateway` share beyond the container:
 * reading ports and probes back from a declared config, and the annotations
 * that record, in the built manifests, how each collector config is deployed.
 *
 * A post-synth check sees only the rendered YAML. The collector config is a
 * string inside a ConfigMap, and whether it runs once per node or as N
 * replicas behind a Service lives on another document. The annotations below
 * join the two, so a check can take a ConfigMap, find its workload, and know
 * the collector's role, its replica count, and (for an agent) which gateway
 * it exports to and whether through `loadbalancing`.
 */

import type { Declarable } from "@intentius/chant/declarable";
import {
  buildCollectorConfig,
  canonicalTypeOf,
  collectorEndpoints,
  collectorYaml,
  COLLECTOR_CONFIG_PATH,
  type BuiltCollector,
} from "@intentius/chant-lexicon-otel";

/**
 * Annotation keys the collector composites write on their ConfigMap and
 * workload. `GkeOtelCollector` writes none of them; its output is fixed.
 *
 * | Key | On | Value |
 * |---|---|---|
 * | `role` | ConfigMap, workload | `agent` (a DaemonSet, one collector per node) or `gateway` (a Deployment) |
 * | `workload` | ConfigMap | the workload that mounts it, `DaemonSet/<name>` or `Deployment/<name>`, in the ConfigMap's namespace |
 * | `config` | workload | the name of the ConfigMap holding its `config.yaml` |
 * | `header` | `OtelOperatorCollector`'s `OpenTelemetryCollector` | the config's `# chant:` header lines (custom-component pins, semconv use), one per line, which an object-valued `spec.config` has no comments to hold |
 * | `gateways` | agent ConfigMap and DaemonSet | comma-separated `<namespace>/<gateway name>=<routing>`, where routing is `loadbalancing` or `service` |
 *
 * The replica count is the workload's own `spec.replicas`.
 */
export const OTEL_COLLECTOR_ANNOTATIONS = {
  role: "otel.chant.dev/role",
  workload: "otel.chant.dev/workload",
  config: "otel.chant.dev/config",
  gateways: "otel.chant.dev/gateways",
  header: "otel.chant.dev/header",
} as const;

export type CollectorRole = "agent" | "gateway";

/** How an agent reaches a gateway: its ClusterIP Service, or each replica through `loadbalancing`. */
export type GatewayRouting = "service" | "loadbalancing";

/** The gateway an exporter built by `gatewayExporter()` points at. */
export interface GatewayTarget {
  name: string;
  namespace: string;
  routing: GatewayRouting;
}

const gatewayTargets = new WeakMap<object, GatewayTarget>();

/** Record which gateway an exporter entity was built for. */
export function markGatewayExporter(exporter: object, target: GatewayTarget): void {
  gatewayTargets.set(exporter, target);
}

/** The gateways a built config's exporters were built for, in declaration order. */
export function gatewayTargetsOf(built: BuiltCollector): GatewayTarget[] {
  const out: GatewayTarget[] = [];
  for (const c of built.components) {
    const t = gatewayTargets.get(c);
    if (t && !out.some((o) => o.name === t.name && o.namespace === t.namespace && o.routing === t.routing)) out.push(t);
  }
  return out;
}

/** The `gateways` annotation value for a list of targets. */
export function gatewaysAnnotation(targets: GatewayTarget[]): string {
  return targets.map((t) => `${t.namespace}/${t.name}=${t.routing}`).join(",");
}

/** A declared collector config, rendered, with the container and Service ports and probes read back from it. */
export interface CollectorRuntime {
  built: BuiltCollector;
  configYaml: string;
  configDir: string;
  containerPorts: Array<{ containerPort: number; name: string; protocol?: "UDP" }>;
  /** The receiver and exporter ports, which the Services expose. The health port is left out. */
  servicePorts: Array<{ name: string; port: number; protocol?: "UDP" }>;
  /** Security context and, when the config enables `health_check`, the probes. */
  containerExtra: Record<string, unknown>;
}

export function collectorRuntime(entities: Declarable[]): CollectorRuntime {
  const built = buildCollectorConfig(entities);
  const { ports, healthCheck } = collectorEndpoints(built.config);
  const configDir = COLLECTOR_CONFIG_PATH.slice(0, COLLECTOR_CONFIG_PATH.lastIndexOf("/"));

  // The probe names the port. A health_check on a receiver's port reuses that
  // port's name, since a container port is declared once.
  const healthPortName = healthCheck ? (ports.find((p) => p.port === healthCheck.port && !p.protocol)?.name ?? "health") : undefined;
  const probe = healthCheck ? { httpGet: { path: healthCheck.path, port: healthPortName } } : undefined;
  const containerPorts = [
    ...ports.map((p) => ({ containerPort: p.port, name: p.name, ...(p.protocol ? { protocol: p.protocol } : {}) })),
    ...(healthCheck && !ports.some((p) => p.port === healthCheck.port && !p.protocol)
      ? [{ containerPort: healthCheck.port, name: "health" }]
      : []),
  ];

  return {
    built,
    configYaml: collectorYaml(entities),
    configDir,
    containerPorts,
    servicePorts: ports.map((p) => ({ name: p.name, port: p.port, ...(p.protocol ? { protocol: p.protocol } : {}) })),
    containerExtra: {
      imagePullPolicy: "IfNotPresent",
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      },
      ...(probe ? { livenessProbe: probe, readinessProbe: probe } : {}),
    },
  };
}

/**
 * The namespaces whose Endpoints a config's `loadbalancing` exporters watch
 * through the `k8s` resolver. A service given as `name` resolves in the
 * collector's own namespace, `name.namespace` in that one.
 */
export function k8sResolverNamespaces(built: BuiltCollector, ownNamespace: string): string[] {
  const out: string[] = [];
  for (const [id, cfg] of Object.entries(built.config.exporters ?? {})) {
    if (canonicalTypeOf("exporter", id) !== "loadbalancing") continue;
    const service = (cfg as { resolver?: { k8s?: { service?: string } } })?.resolver?.k8s?.service;
    if (!service) continue;
    const dot = service.indexOf(".");
    const ns = dot === -1 ? ownNamespace : service.slice(dot + 1);
    if (!out.includes(ns)) out.push(ns);
  }
  return out;
}

/**
 * The namespaces of the Leases a config's `k8s_leader_elector` extensions
 * take, for those `service.extensions` enables (the collector starts no
 * other). An elector without `lease_namespace` fails the otel lexicon's
 * OTEL107 and is skipped here.
 */
export function leaderElectorLeaseNamespaces(built: BuiltCollector): string[] {
  const out: string[] = [];
  const enabled = built.config.service?.extensions ?? [];
  for (const [id, cfg] of Object.entries(built.config.extensions ?? {})) {
    if (id !== "k8s_leader_elector" && !id.startsWith("k8s_leader_elector/")) continue;
    if (!enabled.includes(id)) continue;
    const ns = (cfg as { lease_namespace?: unknown } | null)?.lease_namespace;
    if (typeof ns !== "string" || ns === "") continue;
    if (!out.includes(ns)) out.push(ns);
  }
  return out;
}
