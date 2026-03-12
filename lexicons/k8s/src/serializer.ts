/**
 * Kubernetes YAML serializer.
 *
 * Converts Chant declarables to multi-document K8s YAML output with
 * apiVersion, kind, metadata, and spec structure.
 */

import { createRequire } from "module";
import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { isDefaultLabels, isDefaultAnnotations, type DefaultLabels, type DefaultAnnotations } from "./default-labels";

const require = createRequire(import.meta.url);

/**
 * K8s resource kinds whose properties live directly on the manifest
 * (not nested under `spec`). These types use `data`, `stringData`,
 * or have no spec field at all.
 */
const SPECLESS_TYPES = new Set([
  "ConfigMap",
  "Secret",
  "Namespace",
  "ServiceAccount",
  "ClusterRole",
  "ClusterRoleBinding",
  "Role",
  "RoleBinding",
  "StorageClass",
  "PersistentVolume",
  "APIService",
]);

/**
 * GVK mapping entry — loaded from generated lexicon-k8s.json.
 */
interface GVKEntry {
  resourceType: string;
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
}

let cachedGVKMap: Record<string, GVKEntry> | null = null;

function getGVKMap(): Record<string, GVKEntry> {
  if (cachedGVKMap) return cachedGVKMap;
  try {
    cachedGVKMap = require("./generated/lexicon-k8s.json") as Record<string, GVKEntry>;
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

  // Search for matching entry by resourceType
  for (const entry of Object.values(gvkMap)) {
    if (entry.resourceType === entityType && entry.apiVersion && entry.gvkKind) {
      return { apiVersion: entry.apiVersion, kind: entry.gvkKind };
    }
  }

  // Fallback: derive from entity type string (K8s::Group::Kind → group/v1, Kind)
  return deriveGVKFromType(entityType);
}

/**
 * Well-known K8s API group → apiVersion mappings for fallback when
 * the generated lexicon JSON is not available.
 */
const API_GROUP_VERSIONS: Record<string, string> = {
  Core: "v1",
  Apps: "apps/v1",
  Batch: "batch/v1",
  Networking: "networking.k8s.io/v1",
  Policy: "policy/v1",
  Rbac: "rbac.authorization.k8s.io/v1",
  Storage: "storage.k8s.io/v1",
  Autoscaling: "autoscaling/v2",
  Admissionregistration: "admissionregistration.k8s.io/v1",
  GKE: "cloud.google.com/v1",
  NetworkingGKE: "networking.gke.io/v1",
  NetworkingGKEBeta: "networking.gke.io/v1beta1",
};

function deriveGVKFromType(entityType: string): { apiVersion: string; kind: string } | null {
  // Format: K8s::Group::Kind
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "K8s") return null;

  const group = parts[1];
  const kind = parts[2];
  const apiVersion = API_GROUP_VERSIONS[group];

  if (!apiVersion) return null;
  return { apiVersion, kind };
}

/**
 * K8s visitor for the generic serializer walker.
 */
function k8sVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, attr) => {
      // For K8s, attribute references typically resolve to metadata.name
      if (attr === "name") return name;
      return name;
    },
    resourceRef: (name) => name,
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
  return walkValue(value, entityNames, k8sVisitor(entityNames));
}

/**
 * Kubernetes YAML serializer implementation.
 */
export const k8sSerializer: Serializer = {
  name: "k8s",
  rulePrefix: "WK8",

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

    const namespaceDocs: string[] = [];
    const otherDocs: string[] = [];

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

      // Build the K8s manifest structure
      const manifest: Record<string, unknown> = {
        apiVersion: gvk.apiVersion,
        kind: gvk.kind,
      };

      // Build metadata
      const metadata: Record<string, unknown> = props.metadata as Record<string, unknown> ?? {};
      if (!metadata.name) {
        // Use the logical name as the resource name (kebab-case)
        metadata.name = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      }

      // Merge default labels
      if (Object.keys(defaultLabelEntries).length > 0) {
        const existingLabels = (metadata.labels ?? {}) as Record<string, unknown>;
        metadata.labels = { ...defaultLabelEntries, ...existingLabels };
      }

      // Merge default annotations
      if (Object.keys(defaultAnnotationEntries).length > 0) {
        const existingAnnotations = (metadata.annotations ?? {}) as Record<string, unknown>;
        metadata.annotations = { ...defaultAnnotationEntries, ...existingAnnotations };
      }

      manifest.metadata = metadata;

      // The remaining properties go under spec (or directly on the manifest for certain types)
      if (SPECLESS_TYPES.has(gvk.kind)) {
        // These types have their data directly on the manifest (data, stringData, etc.)
        for (const [key, value] of Object.entries(props)) {
          if (key !== "metadata") {
            manifest[key] = value;
          }
        }
      } else if (props.spec !== undefined) {
        // If spec is already set, use it directly
        manifest.spec = props.spec;
        for (const [key, value] of Object.entries(props)) {
          if (key !== "metadata" && key !== "spec") {
            manifest[key] = value;
          }
        }
      } else {
        // Place remaining props under spec
        const spec: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key !== "metadata") {
            spec[key] = value;
          }
        }
        if (Object.keys(spec).length > 0) {
          manifest.spec = spec;
        }
      }

      // Emit as YAML — sort Namespaces first so kubectl apply succeeds
      const yamlDoc = emitK8sManifest(manifest);
      if (gvk.kind === "Namespace") {
        namespaceDocs.push(yamlDoc);
      } else {
        otherDocs.push(yamlDoc);
      }
    }

    return [...namespaceDocs, ...otherDocs].join("\n---\n");
  },
};

/**
 * Emit a K8s manifest object as YAML.
 * Preserves key ordering: apiVersion, kind, metadata, spec, then rest.
 */
/**
 * Emit a key-value pair as YAML. Scalars get ` value` suffix; objects get
 * block-style indented below the key.
 */
function emitKeyValue(key: string, value: unknown): string {
  const yamlStr = emitYAML(value, 1);
  // If the YAML starts with a newline, it's a block value (object/array)
  if (yamlStr.startsWith("\n")) {
    return `${key}:${yamlStr}`;
  }
  return `${key}: ${yamlStr}`;
}

function emitK8sManifest(manifest: Record<string, unknown>): string {
  const orderedKeys = ["apiVersion", "kind", "metadata", "spec"];
  const lines: string[] = [];

  // Emit ordered keys first
  for (const key of orderedKeys) {
    if (manifest[key] !== undefined) {
      lines.push(emitKeyValue(key, manifest[key]));
    }
  }

  // Emit remaining keys
  for (const [key, value] of Object.entries(manifest)) {
    if (!orderedKeys.includes(key) && value !== undefined) {
      lines.push(emitKeyValue(key, value));
    }
  }

  return lines.join("\n") + "\n";
}
