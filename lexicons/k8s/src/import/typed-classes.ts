/**
 * Which `K8s::Group::Kind` types the k8s lexicon exports a class for, so
 * `chant import` writes a class only when the module it imports from has it
 * (#5070), and only when building that class gives back the apiVersion the
 * file has (#5075).
 */

import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { ResourceIR } from "@intentius/chant/import/parser";
import { metadataHasKey, unknownKeyReason, unknownTopLevelKeys } from "../top-level-fields";

// `require` is not defined where this runs as an ES module; the serializer
// reads the same file the same way.
const require = createRequire(moduleSourceUrl(import.meta.url));

/**
 * Map K8s entity types to their constructor class names.
 */
export const TYPE_TO_CLASS: Record<string, string> = {
  // Core
  "K8s::Core::Pod": "Pod",
  "K8s::Core::Service": "Service",
  "K8s::Core::ConfigMap": "ConfigMap",
  "K8s::Core::Secret": "Secret",
  "K8s::Core::Namespace": "Namespace",
  "K8s::Core::ServiceAccount": "ServiceAccount",
  "K8s::Core::PersistentVolume": "PersistentVolume",
  "K8s::Core::PersistentVolumeClaim": "PersistentVolumeClaim",
  "K8s::Core::Endpoints": "Endpoints",
  "K8s::Core::LimitRange": "LimitRange",
  "K8s::Core::ResourceQuota": "ResourceQuota",

  // Apps
  "K8s::Apps::Deployment": "Deployment",
  "K8s::Apps::StatefulSet": "StatefulSet",
  "K8s::Apps::DaemonSet": "DaemonSet",
  "K8s::Apps::ReplicaSet": "ReplicaSet",

  // Batch
  "K8s::Batch::Job": "Job",
  "K8s::Batch::CronJob": "CronJob",

  // Networking
  "K8s::Networking::Ingress": "Ingress",
  "K8s::Networking::NetworkPolicy": "NetworkPolicy",
  "K8s::Networking::IngressClass": "IngressClass",

  // RBAC
  "K8s::Rbac::Role": "Role",
  "K8s::Rbac::ClusterRole": "ClusterRole",
  "K8s::Rbac::RoleBinding": "RoleBinding",
  "K8s::Rbac::ClusterRoleBinding": "ClusterRoleBinding",

  // Autoscaling
  "K8s::Autoscaling::HorizontalPodAutoscaler": "HorizontalPodAutoscaler",

  // Policy
  "K8s::Policy::PodDisruptionBudget": "PodDisruptionBudget",

  // Storage
  "K8s::Storage::StorageClass": "StorageClass",
};


type LexiconEntry = { resourceType?: string; apiVersion?: string; topLevelFields?: string[] };

let cachedEntries: Record<string, LexiconEntry> | null | undefined;

/** The packaged `lexicon-k8s.json`, or null when this checkout has not generated it. */
function lexiconEntries(): Record<string, LexiconEntry> | null {
  if (cachedEntries !== undefined) return cachedEntries;
  try {
    cachedEntries = require("../generated/lexicon-k8s.json") as Record<string, LexiconEntry>;
  } catch {
    cachedEntries = null;
  }
  return cachedEntries;
}

/**
 * The class `@intentius/chant-lexicon-k8s` exports for an entity type, or
 * undefined when it has none (a custom resource whose CRD is not in the
 * lexicon). A class named like the kind counts only when it constructs this
 * type: two groups can share a kind name.
 */
export function exportedClassFor(type: string): string | undefined {
  const known = TYPE_TO_CLASS[type];
  if (known) return known;

  const parts = type.split("::");
  if (parts.length !== 3 || parts[0] !== "K8s") return undefined;
  const entries = lexiconEntries();
  return entries?.[parts[2]]?.resourceType === type ? parts[2] : undefined;
}

/**
 * The warning for a kind with no class, once per kind. It names the way to
 * get types: list the CRD under `k8s.crds` and run `chant generate`.
 */
export function untypedKindWarning(apiVersion: string, kind: string): string {
  return (
    `${kind} (${apiVersion}) has no class in @intentius/chant-lexicon-k8s; written as an untyped k8sManifest. ` +
    "To get a typed class, list its CRD under k8s.crds in chant.config.ts and run chant generate."
  );
}

let cachedBuiltVersions: Map<string, string> | undefined;

/**
 * The apiVersion the build writes for a class of this entity type, from the
 * packaged lexicon (the same lookup the serializer makes), or undefined when
 * this checkout has not generated it.
 */
export function builtApiVersionFor(type: string): string | undefined {
  if (!cachedBuiltVersions) {
    cachedBuiltVersions = new Map();
    for (const entry of Object.values(lexiconEntries() ?? {})) {
      if (entry.resourceType && entry.apiVersion && !cachedBuiltVersions.has(entry.resourceType)) {
        cachedBuiltVersions.set(entry.resourceType, entry.apiVersion);
      }
    }
  }
  return cachedBuiltVersions.get(type);
}

let cachedTopLevelFields: Map<string, string[]> | undefined;

/**
 * The top-level keys the packaged lexicon says an object of this entity type
 * may carry (#5111), or undefined when the lexicon has no list for it.
 */
export function topLevelFieldsFor(type: string): string[] | undefined {
  if (!cachedTopLevelFields) {
    cachedTopLevelFields = new Map();
    for (const entry of Object.values(lexiconEntries() ?? {})) {
      if (entry.resourceType && entry.topLevelFields && !cachedTopLevelFields.has(entry.resourceType)) {
        cachedTopLevelFields.set(entry.resourceType, entry.topLevelFields);
      }
    }
  }
  return cachedTopLevelFields.get(type);
}

/**
 * How `chant import` writes one parsed object: the one place that decides it.
 * `cls` is set when the object is written as `new <cls>(...)`; otherwise it
 * is an untyped `k8sManifest` and `reason` says why.
 *
 * A class builds with its own apiVersion, so an object whose file says
 * another one (`rbac.authorization.k8s.io/v1beta1` against a class that
 * writes `v1`) would come back from the build at a version nobody wrote, and
 * the fields may not mean the same thing there. Such an object stays
 * untyped at the version in the file, with `builtApiVersion` naming what the
 * class would have written. A document that carries its apiVersion as a
 * property (see `ALIASED_GVKS` in ./parser.ts) builds with it, so it keeps
 * its class.
 *
 * A top-level key the kind does not declare (`labels` written beside
 * `metadata`) is not a property of the class either, so the object is
 * written untyped too, which keeps the key in the build exactly as the file
 * had it (#5111). `unknownKeys` lists them; it is set alongside
 * `other-apiVersion` when both apply.
 */
export interface ImportClass {
  cls?: string;
  reason?: "no-class" | "other-apiVersion" | "unknown-key";
  apiVersion?: string;
  builtApiVersion?: string;
  unknownKeys?: string[];
}

export function importClassFor(resource: Pick<ResourceIR, "type" | "properties" | "metadata">): ImportClass {
  const cls = exportedClassFor(resource.type);
  const apiVersion = resource.metadata?.apiVersion;
  if (!cls) return { reason: "no-class", ...(typeof apiVersion === "string" ? { apiVersion } : {}) };
  if (typeof apiVersion !== "string") return { cls };

  // The document's own keys: its properties, plus the `kind` and `apiVersion` the parser holds in metadata.
  const doc = { ...resource.properties, kind: resource.metadata?.kind, apiVersion };
  const unknownKeys = unknownTopLevelKeys(doc, topLevelFieldsFor(resource.type));
  const unknown = unknownKeys.length > 0 ? { unknownKeys } : {};

  const written = resource.properties?.apiVersion ?? builtApiVersionFor(resource.type);
  if (written !== undefined && written !== apiVersion) {
    return { reason: "other-apiVersion", apiVersion, builtApiVersion: String(written), ...unknown };
  }
  if (unknownKeys.length > 0) return { reason: "unknown-key", apiVersion, ...unknown };
  return { cls };
}

/**
 * The warning for an object kept at its own apiVersion because the lexicon's
 * class is for another one. Names the object, the version in the file and the
 * version the class would have written.
 */
export function keptApiVersionWarning(kind: string, name: string | undefined, apiVersion: string, builtApiVersion: string): string {
  return (
    `${kind}${name ? ` ${name}` : ""} (${apiVersion}): the class in @intentius/chant-lexicon-k8s builds ${builtApiVersion}, ` +
    "so it is written as an untyped k8sManifest that keeps the apiVersion from the file."
  );
}

/**
 * The warning for an object written untyped because its file has a top-level
 * key its kind does not declare: names the object and the key, says what is
 * kept, and why the key matters.
 */
export function unknownTopLevelKeyWarning(kind: string, name: string | undefined, apiVersion: string, key: string, alsoInMetadata: boolean): string {
  return (
    `${kind}${name ? ` ${name}` : ""} (${apiVersion}): ${unknownKeyReason(kind, key, alsoInMetadata)}. ` +
    "It is written as an untyped k8sManifest that keeps the key from the file."
  );
}

/** The warnings for every unknown top-level key of one parsed object, in document order. */
export function unknownTopLevelKeyWarnings(resource: Pick<ResourceIR, "properties" | "metadata">, keys: readonly string[]): string[] {
  const properties = resource.properties as Record<string, unknown>;
  return keys.map((key) =>
    unknownTopLevelKeyWarning(
      String(resource.metadata?.kind),
      resource.metadata?.originalName as string | undefined,
      String(resource.metadata?.apiVersion),
      key,
      metadataHasKey(properties, key),
    ),
  );
}
