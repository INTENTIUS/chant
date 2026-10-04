/**
 * Collector YAML -> `TemplateIR`, for `chant import`.
 *
 * A collector config is one document whose parts name each other: pipelines
 * list component ids, a connector sits in two pipelines, `service.extensions`
 * lists extension ids. So the IR carries the whole config as one resource of
 * type `OTel::Collector`, and the generator lays out the modules itself, with
 * those names turned into imports of declared entities. (Core splits an IR
 * with more than three resources into one generate() call per category and
 * keeps only the first file of each, which would lose the imports between a
 * pipeline and the components it references.)
 *
 * The config is carried as parsed, with nothing dropped from a component's
 * config. What the lexicon cannot express is named in `warnings`.
 *
 * The `# chant:` lines the serializer writes above a config are read back:
 * a custom component's schema pin becomes the pin of the `defineComponent`
 * the generator writes for it. A config without them imports against
 * `COLLECTOR_PIN`.
 */

import * as jsYaml from "js-yaml";
import type { TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import { GENAI_SEMCONV_PIN, type SchemaPin } from "../define";
import {
  COMPONENT_KINDS,
  SECTION_OF,
  SIGNALS,
  canonicalComponentType,
  parseComponentId,
  pipelineSignal,
  type CollectorConfig,
  type ComponentKind,
} from "../model";

/** The IR resource type for a whole collector config. */
export const COLLECTOR_RESOURCE_TYPE = "OTel::Collector";

/** One `# chant: <kind> <id> schema <source>@<version>` header line, read back. */
export interface HeaderPin {
  kind: ComponentKind;
  id: string;
  pin: SchemaPin;
}

/** One `# chant: semconv <namespace> <source>@<version>` header line, read back. */
export interface HeaderSemconv {
  namespace: string;
  pin: SchemaPin;
}

/** What the parser read from a collector YAML file. */
export interface ParsedCollector {
  config: CollectorConfig;
  pins: HeaderPin[];
  semconv: HeaderSemconv[];
  warnings: string[];
}

/** `properties` of the `OTel::Collector` resource. */
export interface CollectorResourceProperties {
  config: CollectorConfig;
}

/** `metadata` of the `OTel::Collector` resource. */
export interface CollectorResourceMetadata {
  pins: HeaderPin[];
  semconv: HeaderSemconv[];
}

// YAML 1.2 core types plus `<<` merge keys. The default schema would also
// turn an unquoted date into a Date, which the collector never does.
// js-yaml exports its built-in types at runtime; @types/js-yaml does not declare them.
const MERGE_TYPE = (jsYaml as unknown as { types: { merge: jsYaml.Type } }).types.merge;
const COLLECTOR_YAML_SCHEMA = jsYaml.CORE_SCHEMA.extend({ implicit: [MERGE_TYPE] });

const SECTIONS = new Set<string>(["receivers", "processors", "exporters", "connectors", "extensions", "service"]);
const SERVICE_KEYS = new Set(["extensions", "telemetry", "pipelines"]);
const PIPELINE_KEYS = new Set(["receivers", "processors", "exporters"]);

const PIN_LINE = /^#\s*chant:\s*(receiver|processor|exporter|connector|extension)\s+(\S+)\s+schema\s+(\S+)@([^@\s]+)(?:\s+(\S+))?\s*$/;
const SEMCONV_LINE = /^#\s*chant:\s*semconv\s+(\S+)\s+(\S+)@([^@\s]+)(?:\s+([^\s(]+))?(?:\s+\(.*\))?\s*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `# chant:` lines of the comment block at the top of the file. */
function readHeader(content: string, warnings: string[]): { pins: HeaderPin[]; semconv: HeaderSemconv[] } {
  const pins: HeaderPin[] = [];
  const semconv: HeaderSemconv[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) break;
    if (!/^#\s*chant:/.test(line)) continue;
    const pin = PIN_LINE.exec(line);
    if (pin) {
      const [, kind, id, source, version, digest] = pin;
      if (source === "(unpinned)" || version === "(unpinned)") continue;
      pins.push({ kind: kind as ComponentKind, id, pin: digest ? { source, version, digest } : { source, version } });
      continue;
    }
    const sc = SEMCONV_LINE.exec(line);
    if (sc) {
      const [, namespace, source, version, digest] = sc;
      semconv.push({ namespace, pin: digest ? { source, version, digest } : { source, version } });
      if (namespace === "gen_ai" && (source !== GENAI_SEMCONV_PIN.source || version !== GENAI_SEMCONV_PIN.version)) {
        warnings.push(
          `the config was built against ${namespace} semantic conventions ${source}@${version}; ` +
            `this lexicon follows ${GENAI_SEMCONV_PIN.source}@${GENAI_SEMCONV_PIN.version}, which the rebuilt config will name`,
        );
      }
      continue;
    }
    warnings.push(`header line "${line}" is not a schema pin chant recognises; it is not carried`);
  }
  return { pins, semconv };
}

/** Parse collector YAML into the plain config model, the header pins and what cannot be carried. */
export function parseCollectorYaml(content: string): ParsedCollector {
  const warnings: string[] = [];
  const { pins, semconv } = readHeader(content, warnings);
  const doc = content.trim() === "" ? {} : jsYaml.load(content, { schema: COLLECTOR_YAML_SCHEMA });
  if (doc === null || doc === undefined) return { config: {}, pins, semconv, warnings };
  if (!isPlainObject(doc)) {
    throw new Error("an OpenTelemetry Collector config is a YAML mapping; this document is not one");
  }

  const config: CollectorConfig = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!SECTIONS.has(key)) {
      warnings.push(`top-level section "${key}" is not part of a collector config; it is not carried`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (!isPlainObject(value)) {
      warnings.push(`"${key}" is not a mapping; it is not carried`);
      continue;
    }
    if (key === "service") continue;
    const section: Record<string, Record<string, unknown> | null> = {};
    for (const [id, cfg] of Object.entries(value)) {
      const parsed = parseComponentId(id);
      if (!parsed) warnings.push(`${key}: "${id}" is not a type[/name] component id`);
      const builtin = parsed && canonicalComponentType(KIND_OF_SECTION[key], parsed.type);
      if (parsed && builtin && builtin !== parsed.type) {
        warnings.push(
          `${key}.${id} uses "${parsed.type}", the collector's newer name for "${builtin}"; it imports as the built-in, which writes "${builtin}"`,
        );
        const renamed = parsed.name === undefined ? builtin : `${builtin}/${parsed.name}`;
        if (renamed in value) warnings.push(`${key}.${id} and ${key}.${renamed} become the same id "${renamed}"; rename one of them`);
      }
      if (cfg !== null && cfg !== undefined && !isPlainObject(cfg)) {
        warnings.push(`${key}.${id} is not a mapping; it is carried as an empty config`);
        section[id] = null;
        continue;
      }
      if (isPlainObject(cfg) && "name" in cfg) {
        warnings.push(
          `${key}.${id} has a config key "name", which chant uses for the instance name; the key is not carried`,
        );
      }
      section[id] = (cfg as Record<string, unknown> | null | undefined) ?? null;
    }
    (config as Record<string, unknown>)[key] = section;
  }

  const service = (doc as Record<string, unknown>).service;
  if (isPlainObject(service)) {
    config.service = {};
    for (const [key, value] of Object.entries(service)) {
      if (!SERVICE_KEYS.has(key)) {
        warnings.push(`service.${key} is not carried; chant's Service declares extensions and telemetry`);
        continue;
      }
      if (value === null || value === undefined) continue;
      if (key === "extensions") {
        if (!Array.isArray(value)) warnings.push("service.extensions is not a list; it is not carried");
        else config.service.extensions = value.map(String);
      } else if (key === "telemetry") {
        if (!isPlainObject(value)) warnings.push("service.telemetry is not a mapping; it is not carried");
        else config.service.telemetry = value;
      } else if (key === "pipelines") {
        if (!isPlainObject(value)) {
          warnings.push("service.pipelines is not a mapping; it is not carried");
          continue;
        }
        config.service.pipelines = {};
        for (const [pid, p] of Object.entries(value)) {
          const signal = pipelineSignal(pid);
          if (!(SIGNALS as readonly string[]).includes(signal)) {
            warnings.push(
              `pipeline "${pid}" carries signal "${signal}", which Pipeline does not type; it is imported with a type suppression`,
            );
          }
          const entry: Record<string, string[]> = {};
          if (isPlainObject(p)) {
            for (const [k, list] of Object.entries(p)) {
              if (!PIPELINE_KEYS.has(k)) {
                warnings.push(`service.pipelines.${pid}.${k} is not carried; a Pipeline has receivers, processors and exporters`);
                continue;
              }
              if (list === null || list === undefined) continue;
              if (!Array.isArray(list)) {
                warnings.push(`service.pipelines.${pid}.${k} is not a list; it is not carried`);
                continue;
              }
              entry[k] = list.map(String);
            }
          }
          config.service.pipelines[pid] = entry;
        }
      }
    }
  }

  return { config, pins, semconv, warnings };
}

/** Which kind a section's components are. */
export const KIND_OF_SECTION: Record<string, ComponentKind> = Object.fromEntries(
  COMPONENT_KINDS.map((k) => [SECTION_OF[k], k]),
);

/** The OpenTelemetry Collector config parser `chant import` runs. */
export class OtelCollectorParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const parsed = parseCollectorYaml(content);
    const properties: CollectorResourceProperties = { config: parsed.config };
    const metadata: CollectorResourceMetadata = { pins: parsed.pins, semconv: parsed.semconv };
    return {
      resources: [
        {
          logicalId: "collector",
          type: COLLECTOR_RESOURCE_TYPE,
          properties: properties as unknown as Record<string, unknown>,
          metadata: metadata as unknown as Record<string, unknown>,
        },
      ],
      parameters: [],
      warnings: parsed.warnings,
    };
  }
}
