/**
 * Declared entities -> `CollectorConfig` -> YAML.
 *
 * The serializer runs this over a build's entities, and a composite in another
 * lexicon (the k8s `GkeOtelCollector`, which puts the YAML in a ConfigMap)
 * runs it over the entities it creates. Both get the same config and the same
 * text.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { definitionFor, isOTelComponent, type OTelComponent } from "./define";
import { SECTION_OF, type CollectorConfig, type PipelineConfig } from "./model";
import { isPipelineEntity, isServiceEntity, type ComponentRef, type PipelineEntity, type ServiceEntity } from "./pipeline";
import { emitCollectorYaml } from "./yaml";

export interface BuiltCollector {
  config: CollectorConfig;
  /** One line per custom component naming its schema pin. Becomes the YAML's `# chant:` header. */
  header: string[];
  /** Non-fatal problems, e.g. two components declaring the same id. */
  warnings: string[];
  components: OTelComponent[];
  pipelines: PipelineEntity[];
  service?: ServiceEntity;
}

function entityList(entities: Iterable<Declarable> | Map<string, Declarable>): Declarable[] {
  return entities instanceof Map ? [...entities.values()] : [...entities];
}

/** A config value with component entities turned into ids and `undefined` keys dropped. */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (isOTelComponent(value)) return value.componentId;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return plain(toJSON.call(value));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = plain(v);
    }
    return out;
  }
  return value;
}

/** A component's config, as it appears under its id: its props without `name`. */
export function componentConfig(component: OTelComponent): Record<string, unknown> {
  const { name: _name, ...rest } = (component.props ?? {}) as Record<string, unknown>;
  return plain(rest) as Record<string, unknown>;
}

function refId(ref: ComponentRef<never> | unknown): string {
  if (isOTelComponent(ref)) return ref.componentId;
  return String(ref);
}

/** Build the collector config for a set of declared entities. Non-otel entities are ignored. */
export function buildCollectorConfig(entities: Iterable<Declarable> | Map<string, Declarable>): BuiltCollector {
  const all = entityList(entities).filter((e) => e && e.lexicon === "otel");
  const warnings: string[] = [];
  const components: OTelComponent[] = [];
  const byId = new Map<string, OTelComponent>();
  const pipelines: PipelineEntity[] = [];
  let service: ServiceEntity | undefined;

  const addComponent = (c: OTelComponent) => {
    const key = `${c.componentKind}:${c.componentId}`;
    const existing = byId.get(key);
    if (existing === c) return;
    if (existing) {
      warnings.push(`otel: two ${c.componentKind}s declare the id "${c.componentId}"; the first one is emitted`);
      return;
    }
    byId.set(key, c);
    components.push(c);
  };

  for (const e of all) {
    if (isOTelComponent(e)) addComponent(e);
    else if (isPipelineEntity(e)) pipelines.push(e);
    else if (isServiceEntity(e)) {
      if (service) warnings.push("otel: more than one Service is declared; the first one is used");
      else service = e;
    }
  }

  // A component a pipeline or the service references by entity is part of the
  // config even when the caller didn't list it: it carries its own config.
  for (const p of pipelines) {
    for (const ref of [...(p.props.receivers ?? []), ...(p.props.processors ?? []), ...(p.props.exporters ?? [])]) {
      if (isOTelComponent(ref)) addComponent(ref);
    }
  }
  for (const ref of service?.props.extensions ?? []) {
    if (isOTelComponent(ref)) addComponent(ref);
  }

  const config: CollectorConfig = {};
  for (const c of components) {
    const section = SECTION_OF[c.componentKind];
    const bucket = (config[section] ??= {});
    bucket[c.componentId] = componentConfig(c);
  }

  const pipelineMap: Record<string, PipelineConfig> = {};
  for (const p of pipelines) {
    if (p.pipelineId in pipelineMap) {
      warnings.push(`otel: two pipelines declare the id "${p.pipelineId}"; the first one is emitted`);
      continue;
    }
    const entry: PipelineConfig = { receivers: (p.props.receivers ?? []).map(refId) };
    const processors = (p.props.processors ?? []).map(refId);
    if (processors.length > 0) entry.processors = processors;
    entry.exporters = (p.props.exporters ?? []).map(refId);
    pipelineMap[p.pipelineId] = entry;
  }

  const extensions = service?.props.extensions
    ? service.props.extensions.map(refId)
    : components.filter((c) => c.componentKind === "extension").map((c) => c.componentId);

  if (pipelines.length > 0 || extensions.length > 0 || service?.props.telemetry) {
    config.service = {};
    if (extensions.length > 0) config.service.extensions = extensions;
    if (service?.props.telemetry) config.service.telemetry = plain(service.props.telemetry) as Record<string, unknown>;
    if (pipelines.length > 0) config.service.pipelines = pipelineMap;
  }

  const header: string[] = [];
  for (const c of components) {
    const def = definitionFor(c.entityType);
    if (!def || def.builtin) continue;
    const pin = def.pin;
    const digest = pin?.digest ? ` ${pin.digest}` : "";
    header.push(`chant: ${c.componentKind} ${c.componentId} schema ${pin?.source ?? "(unpinned)"}@${pin?.version ?? "(unpinned)"}${digest}`);
  }

  return { config, header, warnings, components, pipelines, service };
}

/** Collector YAML for a set of declared entities, exactly as the serializer emits it. */
export function collectorYaml(entities: Iterable<Declarable> | Map<string, Declarable>): string {
  const built = buildCollectorConfig(entities);
  return emitCollectorYaml(built.config, { header: built.header });
}
