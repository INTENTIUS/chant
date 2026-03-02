/**
 * GCP Config Connector YAML serializer.
 *
 * Converts Chant declarables to multi-document K8s YAML output
 * for Config Connector resources with apiVersion, kind, metadata, and spec.
 */

import { createRequire } from "module";
import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { isDefaultLabels, isDefaultAnnotations, type DefaultLabels, type DefaultAnnotations } from "./default-labels";

const require = createRequire(import.meta.url);

/**
 * GVK mapping entry — loaded from generated lexicon-gcp.json.
 */
interface GVKEntry {
  resourceType: string;
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
  group?: string;
}

let cachedGVKMap: Record<string, GVKEntry> | null = null;

function getGVKMap(): Record<string, GVKEntry> {
  if (cachedGVKMap) return cachedGVKMap;
  try {
    cachedGVKMap = require("./generated/lexicon-gcp.json") as Record<string, GVKEntry>;
  } catch {
    cachedGVKMap = {};
  }
  return cachedGVKMap!;
}

/**
 * Resolve entityType to apiVersion and kind.
 */
function resolveGVK(entityType: string): { apiVersion: string; kind: string } | null {
  const gvkMap = getGVKMap();

  for (const entry of Object.values(gvkMap)) {
    if (entry.resourceType === entityType && entry.apiVersion && entry.gvkKind) {
      return { apiVersion: entry.apiVersion, kind: entry.gvkKind };
    }
  }

  // Fallback: derive from entity type string (GCP::Service::Kind → service.cnrm.cloud.google.com/v1beta1, Kind)
  return deriveGVKFromType(entityType);
}

/**
 * Derive GVK from a GCP type name.
 * "GCP::Compute::Instance" → { apiVersion: "compute.cnrm.cloud.google.com/v1beta1", kind: "ComputeInstance" }
 */
function deriveGVKFromType(entityType: string): { apiVersion: string; kind: string } | null {
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "GCP") return null;

  const service = parts[1].toLowerCase();
  const shortKind = parts[2];
  const group = `${service}.cnrm.cloud.google.com`;
  const apiVersion = `${group}/v1beta1`;
  const kind = `${parts[1]}${shortKind}`;

  return { apiVersion, kind };
}

/**
 * GCP visitor for the generic serializer walker.
 */
function gcpVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => {
      // For Config Connector, references resolve to metadata.name
      return name;
    },
    resourceRef: (name) => {
      // Config Connector uses resourceRef pattern: { name: "resource-name" }
      return { name };
    },
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
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

/**
 * Convert a value to YAML-compatible form using the walker.
 */
function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, gcpVisitor(entityNames));
}

/**
 * GCP Config Connector YAML serializer implementation.
 */
export const gcpSerializer: Serializer = {
  name: "gcp",
  rulePrefix: "WGC",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string {
    // Build reverse map: entity → name
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    // Collect default labels and annotations
    let defaultLabelEntries: Record<string, unknown> = {};
    let defaultAnnotationEntries: Record<string, unknown> = {};

    for (const [, entity] of entities) {
      if (isDefaultLabels(entity)) {
        defaultLabelEntries = { ...defaultLabelEntries, ...(entity as DefaultLabels).labels };
      }
      if (isDefaultAnnotations(entity)) {
        defaultAnnotationEntries = { ...defaultAnnotationEntries, ...(entity as DefaultAnnotations).annotations };
      }
    }

    const documents: string[] = [];

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;
      if (isDefaultLabels(entity) || isDefaultAnnotations(entity)) continue;

      const entityType = (entity as unknown as Record<string, unknown>).entityType as string;
      const gvk = resolveGVK(entityType);
      if (!gvk) continue;

      const props = toYAMLValue(
        (entity as unknown as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;

      if (!props) continue;

      // Build the Config Connector manifest structure
      const manifest: Record<string, unknown> = {
        apiVersion: gvk.apiVersion,
        kind: gvk.kind,
      };

      // Build metadata
      const metadata: Record<string, unknown> = props.metadata as Record<string, unknown> ?? {};
      if (!metadata.name) {
        metadata.name = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      }

      // Merge default labels
      if (Object.keys(defaultLabelEntries).length > 0) {
        const existingLabels = (metadata.labels ?? {}) as Record<string, unknown>;
        metadata.labels = { ...defaultLabelEntries, ...existingLabels };
      }

      // Merge default annotations (resolve PseudoParameters to env-var strings)
      if (Object.keys(defaultAnnotationEntries).length > 0) {
        const resolvedAnnotations: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(defaultAnnotationEntries)) {
          resolvedAnnotations[k] = resolveAnnotationValue(v);
        }
        const existingAnnotations = (metadata.annotations ?? {}) as Record<string, unknown>;
        metadata.annotations = { ...resolvedAnnotations, ...existingAnnotations };
      }

      manifest.metadata = metadata;

      // All Config Connector resources use spec
      const spec: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key !== "metadata") {
          spec[key] = value;
        }
      }
      if (Object.keys(spec).length > 0) {
        manifest.spec = spec;
      }

      const yamlDoc = emitK8sManifest(manifest);
      documents.push(yamlDoc);
    }

    return documents.join("\n---\n");
  },
};

/**
 * Pseudo-parameter → environment variable mapping.
 * Config Connector annotations must be plain strings, so PseudoParameters
 * are resolved from environment variables at build time.
 */
const PSEUDO_ENV_MAP: Record<string, { envVar: string; fallback: string }> = {
  "GCP::ProjectId": { envVar: "GCP_PROJECT_ID", fallback: "PROJECT_ID" },
  "GCP::Region": { envVar: "GCP_REGION", fallback: "us-central1" },
  "GCP::Zone": { envVar: "GCP_ZONE", fallback: "us-central1-a" },
};

/**
 * Resolve an annotation value to a plain string.
 * PseudoParameter intrinsics are resolved from environment variables;
 * other values pass through unchanged.
 */
function resolveAnnotationValue(value: unknown): unknown {
  if (typeof value === "object" && value !== null && INTRINSIC_MARKER in value) {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      const json = value.toJSON() as Record<string, unknown>;
      if (json && typeof json === "object" && "Ref" in json && typeof json.Ref === "string") {
        const mapping = PSEUDO_ENV_MAP[json.Ref];
        if (mapping) {
          return process.env[mapping.envVar] ?? mapping.fallback;
        }
      }
    }
    return String(value);
  }
  return value;
}

/**
 * Emit a key-value pair as YAML.
 */
function emitKeyValue(key: string, value: unknown): string {
  const yamlStr = emitYAML(value, 1);
  if (yamlStr.startsWith("\n")) {
    return `${key}:${yamlStr}`;
  }
  return `${key}: ${yamlStr}`;
}

/**
 * Emit a Config Connector manifest object as YAML.
 * Preserves key ordering: apiVersion, kind, metadata, spec.
 */
function emitK8sManifest(manifest: Record<string, unknown>): string {
  const orderedKeys = ["apiVersion", "kind", "metadata", "spec"];
  const lines: string[] = [];

  for (const key of orderedKeys) {
    if (manifest[key] !== undefined) {
      lines.push(emitKeyValue(key, manifest[key]));
    }
  }

  for (const [key, value] of Object.entries(manifest)) {
    if (!orderedKeys.includes(key) && value !== undefined) {
      lines.push(emitKeyValue(key, value));
    }
  }

  return lines.join("\n") + "\n";
}
