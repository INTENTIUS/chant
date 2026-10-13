/**
 * The plain-data model of an OpenTelemetry Collector config.
 *
 * Everything else in this lexicon reads or writes this shape: the serializer
 * builds it from declared entities, the YAML emitter prints it, the checks
 * validate it, and `collectorTopology()` reads it back for other tools. It is
 * exactly the collector's own top-level layout, so a parsed collector YAML
 * file is already a `CollectorConfig` and needs no conversion.
 */

/** The three signals a collector pipeline can carry. */
export const SIGNALS = ["traces", "metrics", "logs"] as const;
export type Signal = (typeof SIGNALS)[number];

/**
 * The component kinds this lexicon types. A connector is an exporter in one
 * pipeline and a receiver in another, which is how one pipeline feeds another
 * (traces into span metrics, say).
 */
export const COMPONENT_KINDS = ["receiver", "processor", "exporter", "connector", "extension"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** A top-level config section that holds components. */
export type ComponentSection = "receivers" | "processors" | "exporters" | "connectors" | "extensions";

/** The top-level config section each component kind lives under. */
export const SECTION_OF: Record<ComponentKind, ComponentSection> = {
  receiver: "receivers",
  processor: "processors",
  exporter: "exporters",
  connector: "connectors",
  extension: "extensions",
};

/**
 * One signal pair a connector supports: it is an exporter in a `from`
 * pipeline and a receiver in a `to` pipeline. `spanmetrics` has one,
 * traces to metrics; `forward` has one per signal. `profiles` is the
 * collector's experimental fourth signal, which `count` reads.
 */
export interface ConnectorSignalPair {
  from: Signal | "profiles";
  to: Signal | "profiles";
}

/** A component id, `type` or `type/name`, exactly as the collector spells it. */
export type ComponentId = string;

/**
 * One pipeline under `service.pipelines`. `receivers` and `exporters` may name
 * connectors as well as receivers and exporters.
 */
export interface PipelineConfig {
  receivers?: ComponentId[];
  processors?: ComponentId[];
  exporters?: ComponentId[];
}

export interface ServiceConfig {
  extensions?: ComponentId[];
  telemetry?: Record<string, unknown>;
  pipelines?: Record<string, PipelineConfig>;
}

/** A whole collector config file. Every section is optional so a partial file still parses. */
export interface CollectorConfig {
  receivers?: Record<ComponentId, Record<string, unknown> | null>;
  processors?: Record<ComponentId, Record<string, unknown> | null>;
  exporters?: Record<ComponentId, Record<string, unknown> | null>;
  extensions?: Record<ComponentId, Record<string, unknown> | null>;
  connectors?: Record<ComponentId, Record<string, unknown> | null>;
  service?: ServiceConfig;
}

/** The collector's id grammar: a type, then optionally `/` and a non-empty name. */
const ID_PATTERN = /^([A-Za-z0-9_]+)(?:\/([^\s/][^\s]*))?$/;

/** Build a component id from a type and an optional instance name. */
export function componentId(type: string, name?: string): ComponentId {
  return name === undefined || name === "" ? type : `${type}/${name}`;
}

/** Split a component id into its type and name, or `undefined` when it isn't valid id syntax. */
export function parseComponentId(id: string): { type: string; name?: string } | undefined {
  const m = ID_PATTERN.exec(id);
  if (!m) return undefined;
  return m[2] === undefined ? { type: m[1] } : { type: m[1], name: m[2] };
}

/** True when `id` is a valid `type[/name]` component id. */
export function isComponentId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** The signal a pipeline id names, e.g. `traces` for `traces/backend`. */
export function pipelineSignal(pipelineId: string): string {
  const slash = pipelineId.indexOf("/");
  return slash === -1 ? pipelineId : pipelineId.slice(0, slash);
}

/** True when a parsed document has the shape of a collector config. */
export function looksLikeCollectorConfig(value: unknown): value is CollectorConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const service = v.service;
  if (typeof service !== "object" || service === null) return false;
  const pipelines = (service as Record<string, unknown>).pipelines;
  if (typeof pipelines !== "object" || pipelines === null) return false;
  return "receivers" in v || "exporters" in v;
}

/**
 * A built-in type the collector renamed, keeping the old name as a
 * deprecated alias. `type` is the new name and `builtin` the name chant's
 * class declares and emits. `since` is the first release of `repo` whose
 * `metadata.yaml` for the component lists `builtin` as `deprecated_type`.
 */
export interface ComponentTypeAlias {
  kind: ComponentKind;
  type: string;
  builtin: string;
  since: string;
  repo: "core" | "contrib";
}

/**
 * The renamed built-ins. chant emits `builtin`, which the pinned collector
 * (`COLLECTOR_PIN`, v0.130.0) knows and newer ones still accept. A config
 * written for a newer collector may use `type`, so code that reads a config
 * (the importer, the checks, the k8s composites) accepts both.
 */
export const COMPONENT_TYPE_ALIASES: readonly ComponentTypeAlias[] = [
  { kind: "exporter", type: "otlp_grpc", builtin: "otlp", since: "v0.148.0", repo: "core" },
  { kind: "exporter", type: "otlp_http", builtin: "otlphttp", since: "v0.148.0", repo: "core" },
  { kind: "processor", type: "k8s_attributes", builtin: "k8sattributes", since: "v0.148.0", repo: "contrib" },
  { kind: "connector", type: "signal_to_metrics", builtin: "signaltometrics", since: "v0.148.0", repo: "contrib" },
  { kind: "receiver", type: "file_log", builtin: "filelog", since: "v0.149.0", repo: "contrib" },
  { kind: "connector", type: "span_metrics", builtin: "spanmetrics", since: "v0.151.0", repo: "contrib" },
  { kind: "connector", type: "service_graph", builtin: "servicegraph", since: "v0.151.0", repo: "contrib" },
  { kind: "receiver", type: "host_metrics", builtin: "hostmetrics", since: "v0.151.0", repo: "contrib" },
  { kind: "receiver", type: "kubelet_stats", builtin: "kubeletstats", since: "v0.152.0", repo: "contrib" },
  { kind: "processor", type: "resource_detection", builtin: "resourcedetection", since: "v0.153.0", repo: "contrib" },
  { kind: "exporter", type: "load_balancing", builtin: "loadbalancing", since: "v0.153.0", repo: "contrib" },
  { kind: "processor", type: "delta_to_cumulative", builtin: "deltatocumulative", since: "v0.158.0", repo: "contrib" },
];

const ALIAS_TO_BUILTIN: ReadonlyMap<string, string> = new Map(COMPONENT_TYPE_ALIASES.map((a) => [`${a.kind}:${a.type}`, a.builtin]));

/** The type chant declares for `kind` + `type`: the old name of a renamed built-in, otherwise `type` itself. */
export function canonicalComponentType(kind: ComponentKind, type: string): string {
  return ALIAS_TO_BUILTIN.get(`${kind}:${type}`) ?? type;
}

/** The type of component id `id`, with a renamed built-in's new name read as the old one: `span_metrics/genai` is `spanmetrics`. */
export function canonicalTypeOf(kind: ComponentKind, id: string): string {
  const slash = id.indexOf("/");
  return canonicalComponentType(kind, slash === -1 ? id : id.slice(0, slash));
}
