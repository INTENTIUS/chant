/**
 * Kubernetes YAML parser for `chant import`.
 *
 * Parses Kubernetes manifests (single or multi-document YAML) into the core
 * TemplateIR format, mapping K8s resources to the K8s::{Group}::{Kind} type
 * convention.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { parseYAML } from "@intentius/chant/yaml";

// ── GVK to type name mapping ───────────────────────────────────────

/**
 * Well-known kind+apiVersion pairs mapped to K8s type names.
 * Key format: "apiVersion/kind" (core group uses just "kind").
 */
const GVK_TYPE_MAP: Record<string, string> = {
  // Core (v1)
  "v1/Pod": "K8s::Core::Pod",
  "v1/Service": "K8s::Core::Service",
  "v1/ConfigMap": "K8s::Core::ConfigMap",
  "v1/Secret": "K8s::Core::Secret",
  "v1/Namespace": "K8s::Core::Namespace",
  "v1/ServiceAccount": "K8s::Core::ServiceAccount",
  "v1/PersistentVolume": "K8s::Core::PersistentVolume",
  "v1/PersistentVolumeClaim": "K8s::Core::PersistentVolumeClaim",
  "v1/Endpoints": "K8s::Core::Endpoints",
  "v1/LimitRange": "K8s::Core::LimitRange",
  "v1/ResourceQuota": "K8s::Core::ResourceQuota",

  // Apps (apps/v1)
  "apps/v1/Deployment": "K8s::Apps::Deployment",
  "apps/v1/StatefulSet": "K8s::Apps::StatefulSet",
  "apps/v1/DaemonSet": "K8s::Apps::DaemonSet",
  "apps/v1/ReplicaSet": "K8s::Apps::ReplicaSet",

  // Batch (batch/v1)
  "batch/v1/Job": "K8s::Batch::Job",
  "batch/v1/CronJob": "K8s::Batch::CronJob",

  // Networking (networking.k8s.io/v1)
  "networking.k8s.io/v1/Ingress": "K8s::Networking::Ingress",
  "networking.k8s.io/v1/NetworkPolicy": "K8s::Networking::NetworkPolicy",
  "networking.k8s.io/v1/IngressClass": "K8s::Networking::IngressClass",

  // RBAC (rbac.authorization.k8s.io/v1)
  "rbac.authorization.k8s.io/v1/Role": "K8s::Rbac::Role",
  "rbac.authorization.k8s.io/v1/ClusterRole": "K8s::Rbac::ClusterRole",
  "rbac.authorization.k8s.io/v1/RoleBinding": "K8s::Rbac::RoleBinding",
  "rbac.authorization.k8s.io/v1/ClusterRoleBinding": "K8s::Rbac::ClusterRoleBinding",

  // Autoscaling (autoscaling/v2)
  "autoscaling/v2/HorizontalPodAutoscaler": "K8s::Autoscaling::HorizontalPodAutoscaler",
  "autoscaling/v1/HorizontalPodAutoscaler": "K8s::Autoscaling::HorizontalPodAutoscaler",

  // Policy (policy/v1)
  "policy/v1/PodDisruptionBudget": "K8s::Policy::PodDisruptionBudget",

  // Storage (storage.k8s.io/v1)
  "storage.k8s.io/v1/StorageClass": "K8s::Storage::StorageClass",

  // Certificates (certificates.k8s.io/v1)
  "certificates.k8s.io/v1/CertificateSigningRequest": "K8s::Certificates::CertificateSigningRequest",

  // Coordination (coordination.k8s.io/v1)
  "coordination.k8s.io/v1/Lease": "K8s::Coordination::Lease",

  // Discovery (discovery.k8s.io/v1)
  "discovery.k8s.io/v1/EndpointSlice": "K8s::Discovery::EndpointSlice",
};

/**
 * Resolve apiVersion + kind to a K8s type name.
 * Falls back to constructing from the apiVersion group.
 */
function resolveTypeName(apiVersion: string, kind: string): string {
  // Try exact match
  const key = `${apiVersion}/${kind}`;
  if (GVK_TYPE_MAP[key]) return GVK_TYPE_MAP[key];

  // Core group uses just kind
  if (apiVersion === "v1") {
    const coreKey = `v1/${kind}`;
    if (GVK_TYPE_MAP[coreKey]) return GVK_TYPE_MAP[coreKey];
  }

  // Construct from apiVersion group
  const group = apiVersionToGroup(apiVersion);
  return `K8s::${group}::${kind}`;
}

/**
 * Extract PascalCase group name from an apiVersion string.
 * "apps/v1" → "Apps"
 * "v1" → "Core"
 * "networking.k8s.io/v1" → "Networking"
 * "rbac.authorization.k8s.io/v1" → "Rbac"
 */
function apiVersionToGroup(apiVersion: string): string {
  const slashIdx = apiVersion.indexOf("/");
  if (slashIdx === -1) return "Core"; // core group (v1)

  const groupStr = apiVersion.slice(0, slashIdx);
  const firstSegment = groupStr.split(".")[0];
  if (firstSegment === "rbac") return "Rbac";
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
}

/**
 * Convert a K8s object name to a camelCase logical identifier.
 * Combines kind (lowercased first char) with the object name (PascalCased).
 *
 * E.g., kind="Deployment", name="my-app" → "deploymentMyApp"
 */
function toLogicalId(kind: string, name: string | undefined): string {
  const prefix = kind.charAt(0).toLowerCase() + kind.slice(1);
  if (!name) return prefix;

  const pascalName = name
    .split(/[-_.]/)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
  return `${prefix}${pascalName}`;
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Kubernetes YAML parser implementation.
 *
 * Supports multi-document YAML (split on `---`). Each document is expected
 * to be a standard Kubernetes object with apiVersion, kind, and metadata.
 */
export class K8sParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const resources: ResourceIR[] = [];
    const namespaces = new Set<string>();

    // Split on YAML document separator, filter blanks
    const documents = content
      .split(/^---\s*$/m)
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && !/^[\s#]*$/.test(d.replace(/#[^\n]*/g, "")));

    for (const docStr of documents) {
      const doc = parseYAML(docStr);
      if (!doc || typeof doc !== "object") continue;

      const resource = this.parseDocument(doc as Record<string, unknown>);
      if (resource) {
        resources.push(resource);

        // Track namespaces
        const ns = (doc as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
        if (ns?.namespace && typeof ns.namespace === "string") {
          namespaces.add(ns.namespace);
        }
      }
    }

    const metadata: Record<string, unknown> = {};
    if (namespaces.size > 0) {
      metadata.namespaces = [...namespaces];
    }

    return {
      resources,
      parameters: [],
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private parseDocument(doc: Record<string, unknown>): ResourceIR | null {
    const apiVersion = doc.apiVersion as string | undefined;
    const kind = doc.kind as string | undefined;

    if (!apiVersion || !kind) return null;

    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    const name = metadata.name as string | undefined;
    const type = resolveTypeName(apiVersion, kind);
    const logicalId = toLogicalId(kind, name);

    // Extract the user-configurable properties (skip apiVersion, kind)
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "apiVersion" || key === "kind") continue;
      properties[key] = value;
    }

    return {
      logicalId,
      type,
      properties,
      metadata: {
        originalName: name,
        apiVersion,
        kind,
        ...(metadata.namespace ? { namespace: metadata.namespace as string } : {}),
      },
    };
  }
}
