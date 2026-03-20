/**
 * Docker lexicon serializer.
 *
 * Splits entities into two output domains:
 * - Docker::Compose::* → docker-compose.yml (primary output)
 * - Docker::Dockerfile → Dockerfile.{name} (per-file entries in SerializerResult)
 *
 * Default labels (DEFAULT_LABELS_MARKER) are merged into every service's
 * labels map but are not emitted as standalone documents.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { emitYAML } from "@intentius/chant/yaml";

// ── Helpers ───────────────────────────────────────────────────────

const DEFAULT_LABELS_MARKER_KEY = Symbol.for("docker.defaultLabels");
const DEFAULT_ANNOTATIONS_MARKER_KEY = Symbol.for("docker.defaultAnnotations");

function isDefaultLabelsEntity(entity: Declarable): boolean {
  return DEFAULT_LABELS_MARKER_KEY in entity;
}

function isDefaultAnnotationsEntity(entity: Declarable): boolean {
  return DEFAULT_ANNOTATIONS_MARKER_KEY in entity;
}

function getProps(entity: Declarable): Record<string, unknown> {
  if ("props" in entity && typeof entity.props === "object" && entity.props !== null) {
    return entity.props as Record<string, unknown>;
  }
  return {};
}

// ── Intrinsic preprocessing ───────────────────────────────────────

function preprocessIntrinsics(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "object" && INTRINSIC_MARKER in (value as object)) {
    if ("toJSON" in (value as object) && typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return ((value as { toJSON(): unknown }).toJSON)();
    }
  }

  if (typeof value === "object" && value !== null && "entityType" in (value as object)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(preprocessIntrinsics);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = preprocessIntrinsics(v);
    }
    return result;
  }

  return value;
}

// ── Visitor ───────────────────────────────────────────────────────

function dockerVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    // For Dockerfile references, emit the filename
    resourceRef: (name) => `Dockerfile.${name}`,
    propertyDeclarable: (entity, walk) => {
      const props = getProps(entity);
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          result[key] = walk(value);
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  const preprocessed = preprocessIntrinsics(value);
  return walkValue(preprocessed, entityNames, dockerVisitor(entityNames));
}

// ── Compose serialization ─────────────────────────────────────────

function serializeCompose(
  services: Map<string, Declarable>,
  volumes: Map<string, Declarable>,
  networks: Map<string, Declarable>,
  configs: Map<string, Declarable>,
  secrets: Map<string, Declarable>,
  defaultLabels: Record<string, string>,
  entityNames: Map<Declarable, string>,
): string {
  const doc: Record<string, unknown> = {};

  if (services.size > 0) {
    const servicesSection: Record<string, unknown> = {};
    for (const [name, entity] of services) {
      const props = toYAMLValue(getProps(entity), entityNames) as Record<string, unknown>;
      // Merge default labels into service labels
      if (Object.keys(defaultLabels).length > 0) {
        const existing = (props.labels as Record<string, string>) ?? {};
        props.labels = { ...defaultLabels, ...existing };
      }
      // Remove undefined values
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v !== undefined && v !== null) cleaned[k] = v;
      }
      servicesSection[name] = cleaned;
    }
    doc.services = servicesSection;
  }

  if (volumes.size > 0) {
    const volumesSection: Record<string, unknown> = {};
    for (const [name, entity] of volumes) {
      const props = toYAMLValue(getProps(entity), entityNames) as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v !== undefined && v !== null) cleaned[k] = v;
      }
      volumesSection[name] = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
    doc.volumes = volumesSection;
  }

  if (networks.size > 0) {
    const networksSection: Record<string, unknown> = {};
    for (const [name, entity] of networks) {
      const props = toYAMLValue(getProps(entity), entityNames) as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v !== undefined && v !== null) cleaned[k] = v;
      }
      networksSection[name] = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
    doc.networks = networksSection;
  }

  if (configs.size > 0) {
    const configsSection: Record<string, unknown> = {};
    for (const [name, entity] of configs) {
      const props = toYAMLValue(getProps(entity), entityNames) as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v !== undefined && v !== null) cleaned[k] = v;
      }
      configsSection[name] = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
    doc.configs = configsSection;
  }

  if (secrets.size > 0) {
    const secretsSection: Record<string, unknown> = {};
    for (const [name, entity] of secrets) {
      const props = toYAMLValue(getProps(entity), entityNames) as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v !== undefined && v !== null) cleaned[k] = v;
      }
      secretsSection[name] = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
    doc.secrets = secretsSection;
  }

  return emitComposeDocument(doc);
}

function emitComposeDocument(doc: Record<string, unknown>): string {
  if (Object.keys(doc).length === 0) return "\n";

  const ORDER = ["services", "volumes", "networks", "configs", "secrets"];
  const sections: string[] = [];
  const emitted = new Set<string>();

  for (const key of ORDER) {
    if (key in doc && doc[key] !== undefined) {
      emitted.add(key);
      sections.push(`${key}:` + emitYAML(doc[key], 1));
    }
  }

  for (const [key, value] of Object.entries(doc)) {
    if (!emitted.has(key) && value !== undefined) {
      sections.push(`${key}:` + emitYAML(value, 1));
    }
  }

  return sections.join("\n\n") + "\n";
}

// ── Dockerfile serialization ──────────────────────────────────────

function serializeDockerfile(entity: Declarable): string {
  const props = getProps(entity);
  const lines: string[] = [];

  // Multi-stage build via stages[]
  if (Array.isArray(props.stages) && props.stages.length > 0) {
    for (const stage of props.stages as Array<Record<string, unknown>>) {
      emitStage(stage, lines);
    }
    return lines.join("\n") + "\n";
  }

  // Single-stage build
  emitStage(props, lines);
  return lines.join("\n") + "\n";
}

function emitStage(stage: Record<string, unknown>, lines: string[]): void {
  // FROM must be first
  if (stage.from) {
    const as = stage.as ? ` AS ${stage.as}` : "";
    lines.push(`FROM ${stage.from}${as}`);
  }

  const INSTRUCTION_ORDER = [
    "arg", "env", "workdir", "user", "run", "copy", "add",
    "expose", "volume", "label", "entrypoint", "cmd", "healthcheck",
  ];

  for (const instr of INSTRUCTION_ORDER) {
    const value = stage[instr];
    if (value === undefined || value === null) continue;

    const keyword = instr.toUpperCase();

    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${keyword} ${item}`);
      }
    } else if (typeof value === "string") {
      lines.push(`${keyword} ${value}`);
    }
  }
}

// ── Serializer ────────────────────────────────────────────────────

export const dockerSerializer: Serializer = {
  name: "docker",
  rulePrefix: "DKR",

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
  ): string | SerializerResult {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    const services = new Map<string, Declarable>();
    const volumes = new Map<string, Declarable>();
    const networks = new Map<string, Declarable>();
    const configs = new Map<string, Declarable>();
    const secrets = new Map<string, Declarable>();
    const dockerfiles = new Map<string, Declarable>();
    let defaultLabels: Record<string, string> = {};

    for (const [name, entity] of entities) {
      // Skip property-kind entities
      if (isPropertyDeclarable(entity)) continue;

      // Skip default labels/annotations markers — collect instead
      if (isDefaultLabelsEntity(entity)) {
        const props = getProps(entity);
        defaultLabels = { ...defaultLabels, ...(props.labels as Record<string, string> ?? {}) };
        continue;
      }
      if (isDefaultAnnotationsEntity(entity)) {
        continue;
      }

      const et = (entity as Record<string, unknown>).entityType as string;

      if (et === "Docker::Compose::Service") {
        services.set(name, entity);
      } else if (et === "Docker::Compose::Volume") {
        volumes.set(name, entity);
      } else if (et === "Docker::Compose::Network") {
        networks.set(name, entity);
      } else if (et === "Docker::Compose::Config") {
        configs.set(name, entity);
      } else if (et === "Docker::Compose::Secret") {
        secrets.set(name, entity);
      } else if (et === "Docker::Dockerfile") {
        dockerfiles.set(name, entity);
      }
    }

    const composeYaml = serializeCompose(
      services, volumes, networks, configs, secrets,
      defaultLabels, entityNames,
    );

    if (dockerfiles.size === 0) {
      return composeYaml;
    }

    const files: Record<string, string> = {};
    for (const [name, entity] of dockerfiles) {
      files[`Dockerfile.${name}`] = serializeDockerfile(entity);
    }

    return { primary: composeYaml, files };
  },
};
