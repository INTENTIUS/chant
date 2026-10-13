/**
 * Where each OpenTelemetry Collector config in a k8s build runs: the join
 * WK8601, WK8602 and WK8603 read (chant #2899).
 *
 * The collector config is a YAML string inside a ConfigMap, and whether it
 * runs once per node or as N replicas lives on another document, the workload
 * that mounts it. A config is joined to its workload in this order:
 *
 * 1. The workload's `otel.chant.dev/config` annotation, written by
 *    `OtelCollector` and `OtelCollectorGateway`, naming the ConfigMap whose
 *    `config.yaml` it runs.
 * 2. Otherwise the ConfigMaps the pod spec mounts as volumes (how
 *    `GkeOtelCollector` and hand-written manifests link them), keeping only
 *    data keys that parse as a collector config (a `service.pipelines` map).
 *    When a container passes `--config=<path>`, only keys named by those
 *    paths count.
 *
 * 3. An OpenTelemetry Operator `OpenTelemetryCollector` carries its config in
 *    `spec.config` (an object in v1beta1, a YAML string in v1alpha1) and its
 *    placement in `spec.mode` and `spec.replicas`; it is its own workload. A
 *    `sidecar` runs inside other pods and is left out. The Services the
 *    operator makes (`<name>-collector`, `<name>-collector-headless`) are not
 *    in the build, so \`servicesSelecting\` names them from the CR.
 *
 * Anything this can't resolve (a ConfigMap or workload outside the build, a
 * replica count that isn't a number) is left out, so the checks stay silent
 * rather than guess. Like every bundle-join check they see one build root at
 * a time (chant #1939).
 *
 * The annotation keys are repeated here rather than imported from the
 * composites, whose module pulls in the otel lexicon; a test pins them to
 * `OTEL_COLLECTOR_ANNOTATIONS`.
 */

import { parseCollectorConfig as parseOtelCollectorConfig } from "@intentius/chant-lexicon-otel/configmap";
import { extractContainers, extractPodSpec, type K8sManifest } from "./k8s-helpers";

export const PLACEMENT_ANNOTATIONS = {
  role: "otel.chant.dev/role",
  workload: "otel.chant.dev/workload",
  config: "otel.chant.dev/config",
  gateways: "otel.chant.dev/gateways",
  header: "otel.chant.dev/header",
} as const;

/** The part of a collector config the placement checks read. */
export interface CollectorConfigShape {
  receivers?: Record<string, unknown>;
  processors?: Record<string, unknown>;
  exporters?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  service: {
    extensions?: unknown;
    pipelines: Record<string, { receivers?: unknown; processors?: unknown; exporters?: unknown }>;
  };
}

/** One collector config and the workload that runs it. */
export interface CollectorPlacement {
  workload: K8sManifest;
  kind: "DaemonSet" | "Deployment" | "StatefulSet";
  name: string;
  namespace: string;
  /**
   * How many copies run at most: `spec.replicas` (1 when unset), raised to a
   * HorizontalPodAutoscaler's `maxReplicas` when one targets the workload.
   * Undefined for a DaemonSet, or when the count isn't a number.
   */
  replicas: number | undefined;
  /** The ConfigMap holding the config; the CR's own name for an `OpenTelemetryCollector`. */
  configMap: string;
  /** The data key holding the config; `spec.config` for an `OpenTelemetryCollector`. */
  key: string;
  config: CollectorConfigShape;
  /** Where the config is, for messages: `ConfigMap observability/x, config.yaml` or `spec.config`. */
  where: string;
  /** The workload is an OpenTelemetry Operator `OpenTelemetryCollector`, which the operator turns into the pods. */
  operatorCR?: true;
}

const PLACED_KINDS = new Set(["DaemonSet", "Deployment", "StatefulSet"]);

const OTEL_OPERATOR_KINDS = { daemonset: "DaemonSet", deployment: "Deployment", statefulset: "StatefulSet" } as const;

/** An OpenTelemetry Operator `OpenTelemetryCollector` (any version of `opentelemetry.io`). */
export function isOperatorCollector(m: K8sManifest): boolean {
  return m.kind === "OpenTelemetryCollector" && typeof m.apiVersion === "string" && m.apiVersion.startsWith("opentelemetry.io/");
}

/** The placement of one `OpenTelemetryCollector`, or undefined for a sidecar, a missing name or a config that isn't one. */
function operatorPlacement(cr: K8sManifest): CollectorPlacement | undefined {
  const name = cr.metadata?.name;
  if (typeof name !== "string") return undefined;
  const mode = cr.spec?.mode === undefined || cr.spec.mode === null ? "deployment" : cr.spec.mode;
  if (typeof mode !== "string" || !(mode in OTEL_OPERATOR_KINDS)) return undefined;
  const kind = OTEL_OPERATOR_KINDS[mode as keyof typeof OTEL_OPERATOR_KINDS];

  // v1beta1 holds the config as an object, v1alpha1 as YAML text.
  const raw = cr.spec?.config;
  const config = isRecord(raw)
    ? (parseCollectorConfig(JSON.stringify(raw)) as CollectorConfigShape | undefined)
    : parseCollectorConfig(raw);
  if (!config) return undefined;

  let replicas: number | undefined;
  if (kind !== "DaemonSet") {
    const r = cr.spec?.replicas;
    const base = r === undefined || r === null ? 1 : typeof r === "number" ? r : undefined;
    const auto = isRecord(cr.spec?.autoscaler) ? cr.spec.autoscaler.maxReplicas : undefined;
    replicas = base === undefined ? undefined : Math.max(base, typeof auto === "number" ? auto : 0);
  }
  return { workload: cr, kind, name, namespace: ns(cr), replicas, configMap: name, key: "spec.config", config, where: "spec.config", operatorCR: true };
}

function ns(m: K8sManifest): string {
  const n = m.metadata?.namespace;
  return typeof n === "string" && n.length > 0 ? n : "default";
}

function annotations(m: K8sManifest): Record<string, unknown> {
  const a = (m.metadata as { annotations?: unknown } | undefined)?.annotations;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a ConfigMap value as a collector config, or undefined when it isn't
 * one. The otel lexicon's parser, shared with its config checks (OTEL101 and
 * the rest) and WK8604 so every check agrees on what counts as a config.
 */
export function parseCollectorConfig(text: unknown): CollectorConfigShape | undefined {
  return parseOtelCollectorConfig(text) as CollectorConfigShape | undefined;
}

/** The `type` of a component id: `tail_sampling/errors` is `tail_sampling`. */
export function componentType(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The pipelines of one signal (`traces`, `traces/sampled`, ...) as [id, pipeline] pairs. */
export function pipelinesOf(config: CollectorConfigShape, signal: string): Array<[string, { receivers: string[]; processors: string[]; exporters: string[] }]> {
  const out: Array<[string, { receivers: string[]; processors: string[]; exporters: string[] }]> = [];
  for (const [id, p] of Object.entries(config.service.pipelines)) {
    if (componentType(id) !== signal || !isRecord(p)) continue;
    out.push([id, { receivers: stringList(p.receivers), processors: stringList(p.processors), exporters: stringList(p.exporters) }]);
  }
  return out;
}

/** Every pipeline, whatever its signal. */
export function allPipelines(config: CollectorConfigShape): Array<[string, { receivers: string[]; processors: string[]; exporters: string[] }]> {
  return ["traces", "metrics", "logs"].flatMap((s) => pipelinesOf(config, s));
}

/** Processor ids of `type` that a traces pipeline runs. */
export function tracePipelineProcessors(config: CollectorConfigShape, type: string): string[] {
  const out = new Set<string>();
  for (const [, p] of pipelinesOf(config, "traces")) {
    for (const id of p.processors) if (componentType(id) === type) out.add(id);
  }
  return [...out];
}

/** The ConfigMap file names a workload's containers pass with `--config`. */
function configArgNames(workload: K8sManifest): string[] {
  const names: string[] = [];
  for (const c of extractContainers(workload)) {
    const argv = [...stringList(c.command), ...stringList(c.args)];
    for (let i = 0; i < argv.length; i++) {
      let path: string | undefined;
      if (argv[i].startsWith("--config=")) path = argv[i].slice("--config=".length);
      else if (argv[i] === "--config") path = argv[i + 1];
      if (!path) continue;
      // `--config=env:...`, `--config=yaml:...` and URLs are not files.
      if (/^[a-z]+:/.test(path)) continue;
      names.push(path.slice(path.lastIndexOf("/") + 1));
    }
  }
  return names;
}

/** ConfigMap names mounted by a workload's pod spec, directly or through a projected volume. */
function mountedConfigMaps(workload: K8sManifest): string[] {
  const pod = extractPodSpec(workload);
  const out: string[] = [];
  for (const v of Array.isArray(pod?.volumes) ? pod.volumes : []) {
    if (!isRecord(v)) continue;
    const cm = isRecord(v.configMap) ? v.configMap.name : undefined;
    if (typeof cm === "string") out.push(cm);
    const sources = isRecord(v.projected) && Array.isArray(v.projected.sources) ? v.projected.sources : [];
    for (const s of sources) {
      const name = isRecord(s) && isRecord(s.configMap) ? s.configMap.name : undefined;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

/** The max replica count an HPA allows for kind/name in a namespace, if one targets it. */
function hpaMax(manifests: K8sManifest[], kind: string, name: string, namespace: string): number | undefined {
  let max: number | undefined;
  for (const m of manifests) {
    if (m.kind !== "HorizontalPodAutoscaler" || ns(m) !== namespace) continue;
    const target = isRecord(m.spec?.scaleTargetRef) ? m.spec.scaleTargetRef : undefined;
    if (!target || target.kind !== kind || target.name !== name) continue;
    const n = m.spec?.maxReplicas;
    if (typeof n === "number") max = Math.max(max ?? 0, n);
  }
  return max;
}

/** Join every collector config in the build to the workload that runs it. */
export function collectorPlacements(manifests: K8sManifest[]): CollectorPlacement[] {
  const configMaps = new Map<string, K8sManifest>();
  for (const m of manifests) {
    if (m.kind === "ConfigMap" && typeof m.metadata?.name === "string") configMaps.set(`${ns(m)}/${m.metadata.name}`, m);
  }

  const out: CollectorPlacement[] = [];
  for (const workload of manifests) {
    if (!workload.kind || !PLACED_KINDS.has(workload.kind)) continue;
    const name = workload.metadata?.name;
    if (typeof name !== "string") continue;
    const namespace = ns(workload);
    const kind = workload.kind as CollectorPlacement["kind"];

    let replicas: number | undefined;
    if (kind !== "DaemonSet") {
      const r = workload.spec?.replicas;
      const base = r === undefined || r === null ? 1 : typeof r === "number" ? r : undefined;
      const hpa = hpaMax(manifests, kind, name, namespace);
      replicas = base === undefined ? undefined : Math.max(base, hpa ?? 0);
    }

    const annotated = annotations(workload)[PLACEMENT_ANNOTATIONS.config];
    const candidates: Array<{ configMap: string; keys?: string[] }> =
      typeof annotated === "string"
        ? [{ configMap: annotated, keys: ["config.yaml"] }]
        : mountedConfigMaps(workload).map((configMap) => ({ configMap }));
    const argNames = configArgNames(workload);

    for (const { configMap, keys } of candidates) {
      const cm = configMaps.get(`${namespace}/${configMap}`);
      if (!cm || !isRecord(cm.data)) continue;
      const parsed: Array<[string, CollectorConfigShape]> = [];
      for (const [key, text] of Object.entries(cm.data)) {
        if (keys && !keys.includes(key)) continue;
        const config = parseCollectorConfig(text);
        if (config) parsed.push([key, config]);
      }
      const named = parsed.filter(([key]) => argNames.includes(key));
      for (const [key, config] of named.length > 0 ? named : parsed) {
        out.push({ workload, kind, name, namespace, replicas, configMap, key, config, where: `ConfigMap ${configMap}, ${key}` });
      }
    }
  }
  for (const m of manifests) {
    if (!isOperatorCollector(m)) continue;
    const p = operatorPlacement(m);
    if (p) out.push(p);
  }
  return out;
}

/** How a placement is described in a message: `DaemonSet observability/otel-agent`. */
export function describePlacement(p: CollectorPlacement): string {
  if (p.operatorCR) return `OpenTelemetryCollector ${p.namespace}/${p.name} (mode ${p.kind.toLowerCase()})`;
  return `${p.kind} ${p.namespace}/${p.name}`;
}

// ── Services and exporters (WK8602) ─────────────────────────────────

/** A Service that selects a workload's pods. */
export interface SelectingService {
  name: string;
  namespace: string;
  headless: boolean;
}

/** The Services in a workload's namespace whose selector matches its pod template labels. */
export function servicesSelecting(manifests: K8sManifest[], workload: K8sManifest): SelectingService[] {
  // The operator's Services for a CR are not in the build; their names are fixed by the operator.
  if (isOperatorCollector(workload) && typeof workload.metadata?.name === "string") {
    const name = workload.metadata.name;
    return [
      { name: `${name}-collector`, namespace: ns(workload), headless: false },
      { name: `${name}-collector-headless`, namespace: ns(workload), headless: true },
    ];
  }
  const template = isRecord(workload.spec?.template) ? workload.spec.template : undefined;
  const labels = isRecord(template?.metadata) && isRecord(template.metadata.labels) ? template.metadata.labels : {};
  const out: SelectingService[] = [];
  for (const m of manifests) {
    if (m.kind !== "Service" || ns(m) !== ns(workload) || typeof m.metadata?.name !== "string") continue;
    const selector = isRecord(m.spec?.selector) ? m.spec.selector : undefined;
    if (!selector || Object.keys(selector).length === 0) continue;
    if (!Object.entries(selector).every(([k, v]) => labels[k] === v)) continue;
    out.push({ name: m.metadata.name, namespace: ns(m), headless: m.spec?.clusterIP === "None" });
  }
  return out;
}

/**
 * The Service a hostname names, as `name.namespace`, when it has the shape of
 * cluster DNS: `name`, `name.ns`, `name.ns.svc` or `name.ns.svc.<domain>`.
 * A bare `name` resolves in the caller's namespace.
 */
export function serviceOfHost(host: string, callerNamespace: string): string | undefined {
  const parts = host.split(".");
  if (parts.some((p) => p.length === 0)) return undefined;
  if (parts.length === 1) return `${parts[0]}.${callerNamespace}`;
  if (parts.length === 2) return `${parts[0]}.${parts[1]}`;
  if (parts[2] === "svc") return `${parts[0]}.${parts[1]}`;
  return undefined;
}

/** The host of an exporter endpoint: `host:port`, `scheme://host:port/path` or `dns:///host:port`. */
export function hostOfEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== "string" || endpoint.length === 0) return undefined;
  let rest = endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, "");
  rest = rest.split("/")[0];
  if (rest.startsWith("[")) return undefined;
  const colon = rest.lastIndexOf(":");
  return colon === -1 ? rest : rest.slice(0, colon);
}
