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
