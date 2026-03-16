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

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedPropertyType {
  name: string;
  /** The definition key in the original schema */
  defType: string;
  properties: ParsedProperty[];
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

export interface K8sParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  gvk: GroupVersionKind;
  /** Whether this entity is a property type (nested inside resources) */
  isProperty?: boolean;
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
}

interface SwaggerProperty extends SwaggerDefinition {
  // Same shape as definition
}

interface SwaggerSpec {
  definitions?: Record<string, SwaggerDefinition>;
  [key: string]: unknown;
}

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
  const spec: SwaggerSpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const definitions = spec.definitions ?? {};
  const results: K8sParseResult[] = [];

  // Phase 1: Extract top-level resources (definitions with GVK)
  for (const [defKey, def] of Object.entries(definitions)) {
    const gvks = def["x-kubernetes-group-version-kind"];
    if (!gvks || gvks.length === 0) continue;

    // Take the first GVK (most definitions have exactly one)
    const gvk = gvks[0];

    // Skip internal/legacy API versions — only take the preferred version
    if (!isPreferredVersion(defKey, gvk, definitions)) continue;

    const typeName = gvkToTypeName(gvk);
    const result = extractResource(defKey, def, typeName, gvk, definitions);
    if (result) results.push(result);
  }

  // Phase 2: Extract well-known property types
  for (const [defKey, config] of Object.entries(PROPERTY_TYPE_DEFS)) {
    const def = definitions[defKey];
    if (!def) continue;

    const result = extractPropertyType(defKey, def, config.typeName, config.description, definitions);
    if (result) results.push(result);
  }

  return results;
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
 * Normalize API group to a PascalCase segment.
 * Empty group (core API) → "Core"
 * "apps" → "Apps"
 * "batch" → "Batch"
 * "rbac.authorization.k8s.io" → "Rbac"
 * "networking.k8s.io" → "Networking"
 */
function normalizeGroup(group: string): string {
  if (!group || group === "") return "Core";

  // Take the first segment before any dots
  const firstSegment = group.split(".")[0];
  // Special-case RBAC
  if (firstSegment === "rbac") return "Rbac";
  // PascalCase the first segment
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
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
  definitions: Record<string, SwaggerDefinition>,
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

  const properties = parseProperties(filteredProps, requiredSet, definitions);

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
  definitions: Record<string, SwaggerDefinition>,
): K8sParseResult | null {
  if (!def.properties) return null;

  const requiredSet = new Set<string>(def.required ?? []);
  const properties = parseProperties(def.properties, requiredSet, definitions);

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
  definitions: Record<string, SwaggerDefinition>,
): ParsedProperty[] {
  const result: ParsedProperty[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const tsType = resolvePropertyType(prop, definitions);
    result.push({
      name,
      tsType,
      required: requiredSet.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: coreExtractConstraints(prop as JsonSchemaProperty),
    });
  }

  return result;
}

/**
 * Resolve a swagger property to its TypeScript type string.
 */
function resolvePropertyType(prop: SwaggerProperty, definitions: Record<string, SwaggerDefinition>): string {
  if (!prop) return "any";

  // Handle $ref
  if (prop.$ref) {
    return resolveRefType(prop.$ref, definitions);
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
        const itemType = resolvePropertyType(prop.items, definitions);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object":
      if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
        const valueType = resolvePropertyType(prop.additionalProperties, definitions);
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
function resolveRefType(ref: string, definitions: Record<string, SwaggerDefinition>): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return "any";

  const defKey = ref.slice(prefix.length);

  // Well-known special types
  if (defKey === "io.k8s.apimachinery.pkg.util.intstr.IntOrString") return "string | number";
  if (defKey === "io.k8s.apimachinery.pkg.api.resource.Quantity") return "string";
  if (defKey === "io.k8s.apimachinery.pkg.apis.meta.v1.Time") return "string";
  if (defKey === "io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime") return "string";
  if (defKey === "io.k8s.apimachinery.pkg.runtime.RawExtension") return "Record<string, any>";

  // Check if it's a known property type
  const ptConfig = PROPERTY_TYPE_DEFS[defKey];
  if (ptConfig) {
    return k8sShortName(ptConfig.typeName);
  }

  // Resolve the definition
  const def = definitions[defKey];
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

  // Object with properties — use Record
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
