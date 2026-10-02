/**
 * Kubernetes OpenAPI Swagger 2.0 parser.
 *
 * Parses the single swagger.json into multiple K8sParseResult entries —
 * one per resource identified by `x-kubernetes-group-version-kind`.
 * Property types (Container, PodSpec, Volume, etc.) are extracted as
 * nested property types within their parent resources.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  extractConstraints as coreExtractConstraints,
  primaryType,
  type JsonSchemaProperty,
} from "@intentius/chant/codegen/json-schema";
import { namespaceSegmentForGroup } from "../group-namespace";

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
  /** `x-kubernetes-list-type` — `map`, `set` or `atomic`. Absent when the spec does not say (chant #1441). */
  listType?: string;
  /** `x-kubernetes-list-map-keys` — the fields that jointly identify one element. Present only alongside `listType: "map"`. */
  listMapKeys?: string[];
}

export interface ParsedPropertyType {
  name: string;
  /** The definition key in the original schema */
  defType: string;
  properties: ParsedProperty[];
}

/**
 * A named OpenAPI object definition emitted as a declaration-only interface
 * in the `.d.ts` (chant #3093): `DeploymentSpec`, `ServiceSpec`, `JobSpec`
 * and every other object definition a resource reaches. Unlike the
 * {@link PROPERTY_TYPE_DEFS} property types it has no runtime constructor and
 * no registry entry; authors write it as an object literal.
 */
export interface ParsedDefinitionType {
  /** TypeScript name, e.g. `DeploymentSpec` or `FlowcontrolSubject`. */
  name: string;
  /** The definition key, e.g. `io.k8s.api.apps.v1.DeploymentSpec`. */
  defKey: string;
  description?: string;
  properties: ParsedProperty[];
}

/** Everything one swagger document yields: resources and property types, plus the declaration-only interfaces. */
export interface K8sSwaggerParse {
  results: K8sParseResult[];
  /** Sorted by name. */
  definitionTypes: ParsedDefinitionType[];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
  deprecatedProperties: string[];
}

export interface GroupVersionKind {
  group: string;
  version: string;
  kind: string;
}

/**
 * How this resource is addressed over the API — chant #1074.
 *
 * Read out of the same document the resource's types come from (the OpenAPI
 * `paths` for core kinds, the CRD's `spec.names` / `spec.scope` for custom
 * ones), so the operation surface and the declarable surface cannot drift
 * apart the way a hand-maintained `kind → kubectl resource` table did.
 *
 * It is a starting point, not the authority: the live client confirms plural
 * and scope against the cluster's own discovery, which is the only thing that
 * knows what a given cluster actually serves.
 */
export interface ParsedOperation {
  /** Plural path segment, e.g. `deployments`. */
  plural: string;
  scope: "Namespaced" | "Cluster";
  /** Verbs the schema documents for the named resource, e.g. `get`, `patch`. */
  verbs: string[];
}

/**
 * Compact, recursive field schema for a custom resource's `spec` — chant #1372.
 *
 * Built-in kinds get their field typing from the generated `.d.ts`. A CRD's
 * constructor takes `spec: Record<string, unknown>`, so its field names, enums
 * and scalar types have to travel through the lexicon JSON instead. This is
 * the shape that ships there: no descriptions, no numeric bounds, only what a
 * validator needs to reject a misspelled field or a wrong-typed value.
 */
export interface CrdFieldSchema {
  /** OpenAPI type; `integer` is kept distinct from `number`. Absent when the schema says nothing. */
  type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
  enum?: string[];
  /** Object members, keyed by field name. */
  fields?: Record<string, CrdFieldSchema>;
  /** Required member names of an object. */
  required?: string[];
  /** Element schema of an array. */
  items?: CrdFieldSchema;
  /**
   * True when the object accepts members its `fields` do not list —
   * `x-kubernetes-preserve-unknown-fields` or `additionalProperties`.
   * `x-kubernetes-int-or-string` also sets it on a scalar, meaning either type passes.
   */
  open?: true;
}

export interface K8sParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  gvk: GroupVersionKind;
  /** Whether this entity is a property type (nested inside resources) */
  isProperty?: boolean;
  /** How the API addresses this resource. Absent for property types. */
  operation?: ParsedOperation;
  /**
   * The `spec` field schema of a custom resource (chant #1372). Present only
   * for CRD-derived kinds whose `openAPIV3Schema` declares a `spec`; built-in
   * kinds carry their typing in the `.d.ts` instead.
   */
  specSchema?: CrdFieldSchema;
}

// ── Swagger types ──────────────────────────────────────────────────

interface SwaggerDefinition {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SwaggerProperty>;
  required?: string[];
  enum?: string[];
  $ref?: string;
  items?: SwaggerProperty;
  additionalProperties?: boolean | SwaggerProperty;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  "x-kubernetes-group-version-kind"?: GroupVersionKind[];
  "x-kubernetes-int-or-string"?: boolean;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  /**
   * How the API server merges this list: `map` (associative, identified by
   * {@link SwaggerDefinition["x-kubernetes-list-map-keys"]}), `set` (unordered,
   * elements are their own identity), or `atomic` (replaced wholesale). chant
   * #1441 — carried through so the drift engine can identify list elements
   * semantically instead of positionally.
   */
  "x-kubernetes-list-type"?: string;
  /** The property names that jointly identify one element of an associative list. */
  "x-kubernetes-list-map-keys"?: string[];
}

interface SwaggerProperty extends SwaggerDefinition {
  // Same shape as definition
}

interface SwaggerSpec {
  definitions?: Record<string, SwaggerDefinition>;
  paths?: Record<string, SwaggerPathItem>;
  [key: string]: unknown;
}

interface SwaggerOperation {
  "x-kubernetes-group-version-kind"?: GroupVersionKind;
  "x-kubernetes-action"?: string;
}

type SwaggerPathItem = Record<string, SwaggerOperation | unknown>;

// ── Well-known property type definitions ───────────────────────────

/**
 * Definitions that should be extracted as standalone property types
 * even though they don't have GVK. Mapped to friendly names.
 */
const PROPERTY_TYPE_DEFS: Record<string, { typeName: string; description: string }> = {
  "io.k8s.api.core.v1.Container": { typeName: "K8s::Core::Container", description: "A container definition for a pod" },
  "io.k8s.api.core.v1.ContainerPort": { typeName: "K8s::Core::ContainerPort", description: "A port to expose from a container" },
  "io.k8s.api.core.v1.EnvVar": { typeName: "K8s::Core::EnvVar", description: "An environment variable for a container" },
  "io.k8s.api.core.v1.EnvFromSource": { typeName: "K8s::Core::EnvFromSource", description: "Source for environment variables" },
  "io.k8s.api.core.v1.Volume": { typeName: "K8s::Core::Volume", description: "A volume that can be mounted by containers" },
  "io.k8s.api.core.v1.VolumeMount": { typeName: "K8s::Core::VolumeMount", description: "A volume mount in a container" },
  "io.k8s.api.core.v1.PodSpec": { typeName: "K8s::Core::PodSpec", description: "Specification of a pod" },
  "io.k8s.api.core.v1.PodTemplateSpec": { typeName: "K8s::Core::PodTemplateSpec", description: "Pod template specification" },
  "io.k8s.api.core.v1.ServicePort": { typeName: "K8s::Core::ServicePort", description: "A port exposed by a service" },
  "io.k8s.api.core.v1.Probe": { typeName: "K8s::Core::Probe", description: "A health check probe" },
  "io.k8s.api.core.v1.ResourceRequirements": { typeName: "K8s::Core::ResourceRequirements", description: "CPU and memory resource requirements" },
  "io.k8s.api.core.v1.SecurityContext": { typeName: "K8s::Core::SecurityContext", description: "Security options for a container" },
  "io.k8s.api.core.v1.PodSecurityContext": { typeName: "K8s::Core::PodSecurityContext", description: "Security options for a pod" },
  "io.k8s.api.core.v1.Capabilities": { typeName: "K8s::Core::Capabilities", description: "Linux capabilities to add or drop" },
  "io.k8s.api.core.v1.ConfigMapKeySelector": { typeName: "K8s::Core::ConfigMapKeySelector", description: "Reference to a key in a ConfigMap" },
  "io.k8s.api.core.v1.SecretKeySelector": { typeName: "K8s::Core::SecretKeySelector", description: "Reference to a key in a Secret" },
  "io.k8s.api.core.v1.EnvVarSource": { typeName: "K8s::Core::EnvVarSource", description: "Source for an environment variable value" },
  "io.k8s.api.core.v1.ObjectReference": { typeName: "K8s::Core::ObjectReference", description: "Reference to another Kubernetes object" },
  "io.k8s.api.core.v1.LocalObjectReference": { typeName: "K8s::Core::LocalObjectReference", description: "Reference to a local object" },
  "io.k8s.api.core.v1.Toleration": { typeName: "K8s::Core::Toleration", description: "A toleration for pod scheduling" },
  "io.k8s.api.core.v1.Affinity": { typeName: "K8s::Core::Affinity", description: "Scheduling affinity rules" },
  "io.k8s.api.core.v1.TopologySpreadConstraint": { typeName: "K8s::Core::TopologySpreadConstraint", description: "Pod topology spread constraint" },
  "io.k8s.api.core.v1.PersistentVolumeClaimSpec": { typeName: "K8s::Core::PersistentVolumeClaimSpec", description: "PVC spec for StatefulSet volume templates" },
  "io.k8s.api.core.v1.HTTPGetAction": { typeName: "K8s::Core::HTTPGetAction", description: "HTTP GET probe action" },
  "io.k8s.api.core.v1.TCPSocketAction": { typeName: "K8s::Core::TCPSocketAction", description: "TCP socket probe action" },
  "io.k8s.api.core.v1.ExecAction": { typeName: "K8s::Core::ExecAction", description: "Exec probe action" },
  "io.k8s.api.core.v1.HostAlias": { typeName: "K8s::Core::HostAlias", description: "Host alias entry for /etc/hosts" },
  "io.k8s.api.core.v1.EphemeralContainer": { typeName: "K8s::Core::EphemeralContainer", description: "An ephemeral container for debugging" },
  "io.k8s.api.core.v1.KeyToPath": { typeName: "K8s::Core::KeyToPath", description: "Maps a key to a file path" },
  "io.k8s.api.apps.v1.DeploymentStrategy": { typeName: "K8s::Apps::DeploymentStrategy", description: "Deployment rolling update strategy" },
  "io.k8s.api.apps.v1.RollingUpdateDeployment": { typeName: "K8s::Apps::RollingUpdateDeployment", description: "Rolling update parameters" },
  "io.k8s.api.networking.v1.IngressRule": { typeName: "K8s::Networking::IngressRule", description: "Ingress routing rule" },
  "io.k8s.api.networking.v1.IngressTLS": { typeName: "K8s::Networking::IngressTLS", description: "Ingress TLS configuration" },
  "io.k8s.api.networking.v1.HTTPIngressPath": { typeName: "K8s::Networking::HTTPIngressPath", description: "HTTP Ingress path" },
  "io.k8s.api.networking.v1.IngressBackend": { typeName: "K8s::Networking::IngressBackend", description: "Ingress backend reference" },
  "io.k8s.api.networking.v1.IngressServiceBackend": { typeName: "K8s::Networking::IngressServiceBackend", description: "Ingress service backend" },
  "io.k8s.api.networking.v1.ServiceBackendPort": { typeName: "K8s::Networking::ServiceBackendPort", description: "Service port reference" },
  "io.k8s.api.networking.v1.NetworkPolicyIngressRule": { typeName: "K8s::Networking::NetworkPolicyIngressRule", description: "NetworkPolicy ingress rule" },
  "io.k8s.api.networking.v1.NetworkPolicyEgressRule": { typeName: "K8s::Networking::NetworkPolicyEgressRule", description: "NetworkPolicy egress rule" },
  "io.k8s.api.networking.v1.NetworkPolicyPeer": { typeName: "K8s::Networking::NetworkPolicyPeer", description: "NetworkPolicy peer selector" },
  "io.k8s.api.networking.v1.NetworkPolicyPort": { typeName: "K8s::Networking::NetworkPolicyPort", description: "NetworkPolicy port" },
  "io.k8s.api.rbac.v1.PolicyRule": { typeName: "K8s::Rbac::PolicyRule", description: "RBAC policy rule" },
  "io.k8s.api.rbac.v1.RoleRef": { typeName: "K8s::Rbac::RoleRef", description: "RBAC role reference" },
  "io.k8s.api.rbac.v1.Subject": { typeName: "K8s::Rbac::Subject", description: "RBAC subject" },
  "io.k8s.api.autoscaling.v2.MetricSpec": { typeName: "K8s::Autoscaling::MetricSpec", description: "HPA metric specification" },
  "io.k8s.api.autoscaling.v2.HorizontalPodAutoscalerBehavior": { typeName: "K8s::Autoscaling::HorizontalPodAutoscalerBehavior", description: "HPA scaling behavior" },
  "io.k8s.api.policy.v1.PodDisruptionBudgetSpec": { typeName: "K8s::Policy::PodDisruptionBudgetSpec", description: "PDB specification" },
  "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": { typeName: "K8s::Meta::ObjectMeta", description: "Standard object metadata" },
  "io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector": { typeName: "K8s::Meta::LabelSelector", description: "Label selector" },
  "io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelectorRequirement": { typeName: "K8s::Meta::LabelSelectorRequirement", description: "Label selector requirement" },
};

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the Kubernetes OpenAPI swagger.json into multiple resource results.
 * Returns one result per top-level resource identified by x-kubernetes-group-version-kind.
 */
export function parseK8sSwagger(data: string | Buffer): K8sParseResult[] {
  return parseK8sSwaggerTypes(data).results;
}

/**
 * Parse the swagger document into resource and property-type results, and the
 * declaration-only interfaces for every other object definition a resource
 * reaches (chant #3093).
 */
export function parseK8sSwaggerTypes(data: string | Buffer): K8sSwaggerParse {
  const spec: SwaggerSpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const definitions = spec.definitions ?? {};
  const results: K8sParseResult[] = [];
  const operations = parseOperations(spec.paths);

  // Which definitions become resources: those with a GVK, preferred version only.
  const resourceDefs: Array<{ defKey: string; def: SwaggerDefinition; gvk: GroupVersionKind }> = [];
  for (const [defKey, def] of Object.entries(definitions)) {
    const gvks = def["x-kubernetes-group-version-kind"];
    if (!gvks || gvks.length === 0) continue;

    // Take the first GVK (most definitions have exactly one)
    const gvk = gvks[0];

    // Skip internal/legacy API versions — only take the preferred version
    if (!isPreferredVersion(defKey, gvk, definitions)) continue;
    resourceDefs.push({ defKey, def, gvk });
  }

  // Name every object definition a resource reaches before any property is
  // typed, so a `$ref` resolves to its interface instead of a Record.
  const reachable = reachableDefinitions(resourceDefs.map((r) => r.def), definitions);
  const ctx: TypeContext = {
    definitions,
    names: nameDefinitions(reachable, definitions),
    resources: new Set(resourceDefs.map((r) => r.defKey)),
  };

  // Phase 1: Extract top-level resources (definitions with GVK)
  for (const { defKey, def, gvk } of resourceDefs) {
    const typeName = gvkToTypeName(gvk);
    const result = extractResource(defKey, def, typeName, gvk, ctx);
    if (result) {
      const operation = operations.get(gvkKey(gvk));
      if (operation) result.operation = operation;
      results.push(result);
    }
  }

  // Phase 2: Extract well-known property types
  for (const [defKey, config] of Object.entries(PROPERTY_TYPE_DEFS)) {
    const def = definitions[defKey];
    if (!def) continue;

    const result = extractPropertyType(defKey, def, config.typeName, config.description, ctx);
    if (result) results.push(result);
  }

  // Phase 3: Every other reachable object definition, as an interface.
  const definitionTypes: ParsedDefinitionType[] = [];
  for (const defKey of reachable) {
    if (PROPERTY_TYPE_DEFS[defKey]) continue;
    const def = definitions[defKey];
    definitionTypes.push({
      name: ctx.names.get(defKey)!,
      defKey,
      description: def.description,
      properties: parseProperties(def.properties ?? {}, new Set(def.required ?? []), ctx),
    });
  }
  definitionTypes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { results, definitionTypes };
}

// ── Definition interfaces (chant #3093) ────────────────────────────

/**
 * Definitions that stay open however they are reached: `RawExtension` holds an
 * arbitrary embedded object, and the rest are scalars on the wire. A Quantity
 * is a string in the schema, but the API server also decodes a number
 * (`cpu: 1`), and manifests write it both ways.
 */
const OPEN_OR_SCALAR_DEFS: Record<string, string> = {
  "io.k8s.apimachinery.pkg.util.intstr.IntOrString": "string | number",
  "io.k8s.apimachinery.pkg.api.resource.Quantity": "string | number",
  "io.k8s.apimachinery.pkg.apis.meta.v1.Time": "string",
  "io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime": "string",
  "io.k8s.apimachinery.pkg.runtime.RawExtension": "Record<string, any>",
};

interface TypeContext {
  definitions: Record<string, SwaggerDefinition>;
  /** Definition key → TypeScript name, for every definition typed as a class or interface. */
  names: Map<string, string>;
  /** Emitted resource definitions, by key. */
  resources: Set<string>;
  /** Resource definitions being inlined, to stop a cycle. */
  inlining?: Set<string>;
}

/**
 * A resource embedded in another object (`StatefulSetSpec.volumeClaimTemplates`
 * holds PersistentVolumeClaims, a List holds its items) is typed inline with
 * the props its class takes. A name would have to avoid the class's own.
 */
function inlineResourceType(defKey: string, ctx: TypeContext): string {
  const inlining = ctx.inlining ?? new Set<string>();
  if (inlining.has(defKey)) return "Record<string, any>";
  const def = ctx.definitions[defKey];
  const inner: TypeContext = { ...ctx, inlining: new Set([...inlining, defKey]) };
  const required = new Set(def.required ?? []);
  const members = Object.entries(def.properties ?? {})
    .filter(([name]) => name !== "apiVersion" && name !== "kind" && name !== "status")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${resolvePropertyType(prop, inner)}`);
  return members.length === 0 ? "Record<string, any>" : `{ ${members.join("; ")} }`;
}

/**
 * Whether a definition becomes a named type: an object with properties that
 * is not itself a resource. A `$ref` to a resource is typed inline instead
 * ({@link inlineResourceType}).
 */
function isNamedObjectDef(defKey: string, def: SwaggerDefinition | undefined): def is SwaggerDefinition {
  if (!def?.properties || defKey in OPEN_OR_SCALAR_DEFS) return false;
  return !def["x-kubernetes-group-version-kind"]?.length;
}

/**
 * The object definitions reachable from the resources' authored properties
 * (everything but `apiVersion`, `kind` and `status`), plus the well-known
 * property types. Sorted by key. A recursive definition such as
 * `JSONSchemaProps` is visited once and refers to itself by name, so no depth
 * bound is needed.
 */
function reachableDefinitions(
  resources: SwaggerDefinition[],
  definitions: Record<string, SwaggerDefinition>,
): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const visitRef = (defKey: string) => {
    if (seen.has(defKey) || !isNamedObjectDef(defKey, definitions[defKey])) return;
    seen.add(defKey);
    queue.push(defKey);
  };
  const walk = (prop: SwaggerProperty | undefined) => {
    if (!prop) return;
    if (prop.$ref) {
      if (prop.$ref.startsWith("#/definitions/")) visitRef(prop.$ref.slice("#/definitions/".length));
      return;
    }
    walk(prop.items);
    if (prop.additionalProperties && typeof prop.additionalProperties === "object") walk(prop.additionalProperties);
  };

  for (const def of resources) {
    for (const [name, prop] of Object.entries(def.properties ?? {})) {
      if (name !== "apiVersion" && name !== "kind" && name !== "status") walk(prop);
    }
  }
  for (const defKey of Object.keys(PROPERTY_TYPE_DEFS)) visitRef(defKey);
  while (queue.length > 0) {
    const def = definitions[queue.shift()!];
    for (const prop of Object.values(def.properties ?? {})) walk(prop);
  }
  return [...seen].sort();
}

const VERSION_SEGMENT = /^v\d+((alpha|beta)\d+)?$/;

/** `io.k8s.api.flowcontrol.v1.Subject` → `{ group: "Flowcontrol", version: "V1", kind: "Subject" }`. */
function definitionKeyParts(defKey: string): { group: string; version: string; kind: string } {
  const parts = defKey.split(".");
  const kind = parts[parts.length - 1];
  const vIdx = parts.length - 2;
  const version = VERSION_SEGMENT.test(parts[vIdx] ?? "") ? parts[vIdx] : "";
  const group = (version ? parts[vIdx - 1] : parts[vIdx]) ?? "";
  const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return { group: pascal(group), version: pascal(version), kind };
}

/**
 * Give every reachable definition a TypeScript name.
 *
 * The well-known property types keep their friendly names. Every other
 * definition takes the last segment of its key (`DeploymentSpec`) when no
 * other reachable definition shares that segment and no resource kind or
 * friendly name already uses it. Otherwise each contender is qualified by its
 * API group (`FlowcontrolSubject`, `CoreResourceClaim`), and by group and
 * version when one group has several (`ResourceV1beta2Device`). The rule
 * reads only the set of keys, so the result does not depend on the order of
 * the document.
 */
function nameDefinitions(reachable: string[], definitions: Record<string, SwaggerDefinition>): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const def of Object.values(definitions)) {
    for (const gvk of def["x-kubernetes-group-version-kind"] ?? []) taken.add(gvk.kind);
  }
  for (const [defKey, config] of Object.entries(PROPERTY_TYPE_DEFS)) {
    const name = k8sShortName(config.typeName);
    names.set(defKey, name);
    taken.add(name);
  }

  const byKind = new Map<string, string[]>();
  for (const defKey of reachable) {
    if (names.has(defKey)) continue;
    const { kind } = definitionKeyParts(defKey);
    byKind.set(kind, [...(byKind.get(kind) ?? []), defKey]);
  }

  for (const [kind, keys] of byKind) {
    if (keys.length === 1 && !taken.has(kind)) {
      names.set(keys[0], kind);
      continue;
    }
    const groupCount = new Map<string, number>();
    for (const k of keys) {
      const { group } = definitionKeyParts(k);
      groupCount.set(group, (groupCount.get(group) ?? 0) + 1);
    }
    for (const k of keys) {
      const { group, version } = definitionKeyParts(k);
      names.set(k, groupCount.get(group)! > 1 ? `${group}${version}${kind}` : `${group}${kind}`);
    }
  }

  const owner = new Map<string, string>();
  for (const [defKey, name] of names) {
    const prev = owner.get(name);
    if (prev) throw new Error(`k8s codegen: definitions ${prev} and ${defKey} both map to the type name ${name}`);
    owner.set(name, defKey);
  }
  return names;
}

/** Stable key for a GVK, used to join the `paths` pass onto the `definitions` pass. */
/**
 * Every `(property name, list-map keys)` pair the spec declares, across ALL
 * definitions (chant #1441).
 *
 * Deliberately independent of {@link parseK8sSwagger}'s resource/property-type
 * extraction. That extraction keeps 257 resources and 320 property types out
 * of roughly a thousand definitions, so collecting merge keys from its output
 * alone finds 18 of the 32 properties the spec annotates — and misses
 * `ServicePort.port`, whose absence would silently demote every Service port
 * list to the hand-written fallback. A definition is worth reading for its
 * merge semantics whether or not chant emits a type for it.
 */
export function specListMapKeyPairs(data: string | Buffer): Array<[string, string[]]> {
  const spec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as SwaggerSpec;
  const pairs: Array<[string, string[]]> = [];

  for (const def of Object.values(spec.definitions ?? {})) {
    for (const [name, prop] of Object.entries(def.properties ?? {})) {
      if (prop["x-kubernetes-list-type"] !== "map") continue;
      const keys = prop["x-kubernetes-list-map-keys"];
      if (keys?.length) pairs.push([name, [...keys]]);
    }
  }

  return pairs;
}

export function gvkKey(gvk: GroupVersionKind): string {
  return `${gvk.group}|${gvk.version}|${gvk.kind}`;
}

/**
 * Derive the operation surface from the OpenAPI `paths` — chant #1074.
 *
 * Every Kubernetes operation carries `x-kubernetes-group-version-kind` and
 * `x-kubernetes-action`, and the path itself carries the two facts a REST call
 * needs and a definition does not have: the plural segment, and whether the
 * resource is namespaced (`/namespaces/{namespace}/` appears in its path).
 *
 * Only paths addressing a single named object (`.../{plural}/{name}`) are read,
 * so subresource paths (`.../{name}/status`, `.../{name}/scale`) and collection
 * paths do not supply the plural — but their verbs are collected, because
 * "this kind can be listed" is worth knowing.
 */
export function parseOperations(paths: Record<string, SwaggerPathItem> | undefined): Map<string, ParsedOperation> {
  const out = new Map<string, ParsedOperation>();
  if (!paths) return out;

  for (const [path, item] of Object.entries(paths)) {
    for (const operation of Object.values(item ?? {})) {
      if (!operation || typeof operation !== "object") continue;
      const op = operation as SwaggerOperation;
      const gvk = op["x-kubernetes-group-version-kind"];
      const action = op["x-kubernetes-action"];
      if (!gvk || !action) continue;

      const segments = path.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      // `.../{plural}/{name}` — the only shape that names the plural
      // unambiguously. `/api/v1/namespaces/{name}` is such a shape too, and
      // correctly yields plural `namespaces`, cluster-scoped.
      if (last !== "{name}") continue;
      const plural = segments[segments.length - 2];
      if (!plural || plural.startsWith("{")) continue;

      const key = gvkKey(gvk);
      const existing = out.get(key);
      if (existing) {
        if (!existing.verbs.includes(action)) existing.verbs.push(action);
        continue;
      }
      out.set(key, {
        plural,
        scope: path.includes("/namespaces/{namespace}/") ? "Namespaced" : "Cluster",
        verbs: [action],
      });
    }
  }

  for (const operation of out.values()) operation.verbs.sort();
  return out;
}

/**
 * Convert GVK to our type name convention: K8s::{Group}::{Kind}
 */
export function gvkToTypeName(gvk: GroupVersionKind): string {
  const group = normalizeGroup(gvk.group);
  return `K8s::${group}::${gvk.kind}`;
}

/**
 * Convert GVK to apiVersion string for serialization.
 */
export function gvkToApiVersion(gvk: GroupVersionKind): string {
  if (!gvk.group || gvk.group === "") {
    return gvk.version; // core group: "v1"
  }
  return `${gvk.group}/${gvk.version}`; // e.g. "apps/v1"
}

/**
 * Normalize API group to a PascalCase segment — the shared rule, so the
 * swagger-generated surface, kustomize-rendered entities and live discovery
 * (all three reach here through `gvkToTypeName`) spell a kind exactly as CRD
 * codegen and `chant import` do. See `../group-namespace`.
 */
function normalizeGroup(group: string): string {
  return namespaceSegmentForGroup(group);
}

/**
 * Check if this definition key represents the preferred API version.
 * Prefer stable (v1) over beta/alpha, and prefer the highest stable version.
 */
function isPreferredVersion(defKey: string, gvk: GroupVersionKind, definitions: Record<string, SwaggerDefinition>): boolean {
  // Skip alpha versions
  if (gvk.version.includes("alpha")) return false;

  // Find all definitions with the same GVK kind+group
  const sameName: Array<{ key: string; version: string }> = [];
  for (const [key, def] of Object.entries(definitions)) {
    const gvks = def["x-kubernetes-group-version-kind"];
    if (!gvks) continue;
    for (const g of gvks) {
      if (g.kind === gvk.kind && g.group === gvk.group) {
        sameName.push({ key, version: g.version });
      }
    }
  }

  if (sameName.length <= 1) return true;

  // Prefer stable (v1, v2) over beta
  const stable = sameName.filter((s) => !s.version.includes("beta") && !s.version.includes("alpha"));
  if (stable.length > 0) {
    // Among stable, pick the highest version
    stable.sort((a, b) => b.version.localeCompare(a.version));
    return defKey === stable[0].key;
  }

  // All beta — pick highest
  sameName.sort((a, b) => b.version.localeCompare(a.version));
  return defKey === sameName[0].key;
}

/**
 * Extract a top-level resource from a swagger definition.
 */
function extractResource(
  defKey: string,
  def: SwaggerDefinition,
  typeName: string,
  gvk: GroupVersionKind,
  ctx: TypeContext,
): K8sParseResult | null {
  if (!def.properties) return null;

  const requiredSet = new Set<string>(def.required ?? []);

  // K8s resources have standard fields (apiVersion, kind, metadata, spec, status)
  // We only expose user-configurable properties — skip apiVersion, kind, status
  const skipProps = new Set(["apiVersion", "kind", "status"]);
  const filteredProps: Record<string, SwaggerProperty> = {};
  for (const [name, prop] of Object.entries(def.properties)) {
    if (!skipProps.has(name)) {
      filteredProps[name] = prop;
    }
  }

  const properties = parseProperties(filteredProps, requiredSet, ctx);

  return {
    resource: {
      typeName,
      description: def.description,
      properties,
      attributes: [
        { name: "name", tsType: "string" },
        { name: "namespace", tsType: "string" },
        { name: "uid", tsType: "string" },
      ],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
    gvk,
  };
}

/**
 * Extract a property type definition (not a top-level resource).
 */
function extractPropertyType(
  defKey: string,
  def: SwaggerDefinition,
  typeName: string,
  description: string,
  ctx: TypeContext,
): K8sParseResult | null {
  if (!def.properties) return null;

  const requiredSet = new Set<string>(def.required ?? []);
  const properties = parseProperties(def.properties, requiredSet, ctx);

  const gvkParts = typeName.split("::");
  return {
    resource: {
      typeName,
      description,
      properties,
      attributes: [],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
    gvk: { group: gvkParts[1]?.toLowerCase() ?? "", version: "v1", kind: gvkParts[2] ?? "" },
    isProperty: true,
  };
}

/**
 * Parse properties from a swagger definition into ParsedProperty[].
 */
function parseProperties(
  properties: Record<string, SwaggerProperty>,
  requiredSet: Set<string>,
  ctx: TypeContext,
): ParsedProperty[] {
  const result: ParsedProperty[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const tsType = resolvePropertyType(prop, ctx);
    const parsed: ParsedProperty = {
      name,
      tsType,
      required: requiredSet.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: coreExtractConstraints(prop as JsonSchemaProperty),
    };
    // chant #1441 — the merge semantics the API server itself uses. Kept only
    // when present; a spec that says nothing leaves both fields absent rather
    // than asserting a default the schema did not state.
    const listType = prop["x-kubernetes-list-type"];
    if (listType) parsed.listType = listType;
    const listMapKeys = prop["x-kubernetes-list-map-keys"];
    if (listMapKeys?.length) parsed.listMapKeys = [...listMapKeys];
    result.push(parsed);
  }

  return result;
}

/**
 * Resolve a swagger property to its TypeScript type string.
 */
function resolvePropertyType(prop: SwaggerProperty, ctx: TypeContext): string {
  if (!prop) return "any";

  // Handle $ref
  if (prop.$ref) {
    return resolveRefType(prop.$ref, ctx);
  }

  // x-kubernetes-int-or-string
  if (prop["x-kubernetes-int-or-string"]) {
    return "string | number";
  }

  // Inline enum
  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const pt = primaryType(prop.type);
  switch (pt) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (prop.items) {
        const itemType = resolvePropertyType(prop.items, ctx);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object":
      if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
        const valueType = resolvePropertyType(prop.additionalProperties, ctx);
        return `Record<string, ${valueType}>`;
      }
      return "Record<string, any>";
    default:
      return "any";
  }
}

/**
 * Resolve a $ref to a TypeScript type.
 */
function resolveRefType(ref: string, ctx: TypeContext): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return "any";

  const defKey = ref.slice(prefix.length);

  // Well-known scalars, and RawExtension, which stays open.
  const fixed = OPEN_OR_SCALAR_DEFS[defKey];
  if (fixed) return fixed;

  // A property class or a definition interface (chant #3093).
  const named = ctx.names.get(defKey);
  if (named) return named;
  if (ctx.resources.has(defKey)) return inlineResourceType(defKey, ctx);

  // Resolve the definition
  const def = ctx.definitions[defKey];
  if (!def) return "any";

  // Enum
  if (def.enum && def.enum.length > 0 && !def.properties) {
    return def.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Primitive type
  if (def.type && !def.properties) {
    const pt = primaryType(def.type);
    switch (pt) {
      case "string": return "string";
      case "integer":
      case "number": return "number";
      case "boolean": return "boolean";
      default: return "any";
    }
  }

  // An object this pass does not name: a resource of a non-preferred
  // version, or a definition with no properties (`JSON`, `FieldsV1`).
  if (def.properties) return "Record<string, any>";

  return "any";
}

/**
 * Extract short name: "K8s::Apps::Deployment" → "Deployment"
 */
export function k8sShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/**
 * Extract service/group name: "K8s::Apps::Deployment" → "Apps"
 */
export function k8sServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : "Core";
}
