/**
 * Where telemetry goes, as plain data.
 *
 * `collectorTopology()` reads a collector config (declared, or parsed from a
 * YAML file) and returns its pipelines, its components with their endpoints
 * and schema pins, and for each exporter the pipelines and signals it
 * carries. It is the surface a reader such as `chant workspace graph` uses to
 * say where a member's telemetry is sent, and what a declared telemetry
 * endpoint link can point at.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { buildCollectorConfig } from "./collector";
import { definitionOf, type SchemaPin } from "./define";
import { parseComponentId, pipelineSignal, SECTION_OF, type CollectorConfig, type ComponentKind } from "./model";

export interface TopologyPipeline {
  /** The id under `service.pipelines`, e.g. `traces` or `traces/backend`. */
  id: string;
  /** `traces`, `metrics` or `logs`. */
  signal: string;
  receivers: string[];
  processors: string[];
  exporters: string[];
}

export interface TopologyComponent {
  /** The collector id, `type` or `type/name`. */
  id: string;
  kind: ComponentKind;
  type: string;
  name?: string;
  /** True for a component this package ships; false for a custom one, or one this process has no definition for. */
  builtin: boolean;
  /** The schema pin of its definition, when this process has the definition. */
  schema?: SchemaPin;
  /** Addresses it listens on or sends to, as the config states them. Empty when the config names none. */
  endpoints: string[];
  /** The pipelines that use it. For an extension, empty. */
  pipelines: string[];
}

export interface TopologyExporter {
  id: string;
  type: string;
  endpoints: string[];
  pipelines: string[];
  /** The signals that reach it, deduplicated, in pipeline order. */
  signals: string[];
}

export interface CollectorTopology {
  pipelines: TopologyPipeline[];
  components: TopologyComponent[];
  /** The exporters again, grouped for the question "where does this telemetry go". */
  exporters: TopologyExporter[];
}

function endpointsOf(kind: ComponentKind, type: string, config: Record<string, unknown> | null | undefined): string[] {
  const def = definitionOf(kind, type);
  const cfg = config ?? {};
  if (def?.endpoints) {
    try {
      return def.endpoints(cfg as never);
    } catch {
      return [];
    }
  }
  return typeof cfg.endpoint === "string" && cfg.endpoint !== "" ? [cfg.endpoint] : [];
}

/** The topology of a collector config. */
export function collectorTopology(config: CollectorConfig): CollectorTopology {
  const pipelines: TopologyPipeline[] = Object.entries(config.service?.pipelines ?? {}).map(([id, p]) => ({
    id,
    signal: pipelineSignal(id),
    receivers: (p?.receivers ?? []).map(String),
    processors: (p?.processors ?? []).map(String),
    exporters: (p?.exporters ?? []).map(String),
  }));

  const components: TopologyComponent[] = [];
  for (const kind of Object.keys(SECTION_OF) as ComponentKind[]) {
    const section = SECTION_OF[kind];
    for (const [id, cfg] of Object.entries(config[section] ?? {})) {
      const parsed = parseComponentId(id);
      const type = parsed?.type ?? id;
      const def = definitionOf(kind, type);
      const field = section as "receivers" | "processors" | "exporters" | "extensions";
      const inPipelines =
        field === "extensions" ? [] : pipelines.filter((p) => p[field].includes(id)).map((p) => p.id);
      components.push({
        id,
        kind,
        type,
        ...(parsed?.name !== undefined ? { name: parsed.name } : {}),
        builtin: def?.builtin ?? false,
        ...(def ? { schema: { ...def.pin } } : {}),
        endpoints: endpointsOf(kind, type, cfg),
        pipelines: inPipelines,
      });
    }
  }

  const exporters: TopologyExporter[] = components
    .filter((c) => c.kind === "exporter")
    .map((c) => {
      const signals: string[] = [];
      for (const pid of c.pipelines) {
        const s = pipelineSignal(pid);
        if (!signals.includes(s)) signals.push(s);
      }
      return { id: c.id, type: c.type, endpoints: c.endpoints, pipelines: c.pipelines, signals };
    });

  return { pipelines, components, exporters };
}

/** The topology of declared entities, i.e. of the config the serializer would emit for them. */
export function collectorTopologyOf(entities: Iterable<Declarable> | Map<string, Declarable>): CollectorTopology {
  return collectorTopology(buildCollectorConfig(entities).config);
}
