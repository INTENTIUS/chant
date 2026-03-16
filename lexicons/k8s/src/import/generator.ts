/**
 * TypeScript code generator for Kubernetes import.
 *
 * Converts a TemplateIR (from parsed K8s manifests) into TypeScript
 * source code using the @intentius/chant-lexicon-k8s constructors.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

/**
 * Map K8s entity types to their constructor class names.
 */
const TYPE_TO_CLASS: Record<string, string> = {
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

/**
 * Properties that reference known property entity constructors.
 * Key: property name found in K8s specs → Value: constructor class name.
 */
const PROPERTY_CONSTRUCTORS: Record<string, string> = {
  containers: "Container",
  initContainers: "Container",
  ephemeralContainers: "EphemeralContainer",
  volumes: "Volume",
  volumeMounts: "VolumeMount",
  ports: "ContainerPort",
  env: "EnvVar",
  envFrom: "EnvFromSource",
  resources: "ResourceRequirements",
  securityContext: "SecurityContext",
  podSecurityContext: "PodSecurityContext",
  livenessProbe: "Probe",
  readinessProbe: "Probe",
  startupProbe: "Probe",
  selector: "LabelSelector",
  template: "PodTemplateSpec",
  strategy: "DeploymentStrategy",
  affinity: "Affinity",
  tolerations: "Toleration",
  topologySpreadConstraints: "TopologySpreadConstraint",
  rules: "IngressRule",
  tls: "IngressTLS",
  ingress: "NetworkPolicyIngressRule",
  egress: "NetworkPolicyEgressRule",
};

/**
 * Service port properties need distinct handling since K8s uses "ports"
 * for both ContainerPort and ServicePort depending on the parent resource.
 */
const SERVICE_PORT_TYPES = new Set([
  "K8s::Core::Service",
]);

/**
 * Generate TypeScript source code from a Kubernetes IR.
 */
export class K8sGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    // Collect which constructors are needed
    const usedConstructors = new Set<string>();
    for (const resource of ir.resources) {
      const cls = this.resolveClass(resource.type);
      if (cls) usedConstructors.add(cls);

      // Check properties for nested constructors
      this.collectNestedConstructors(resource.properties, usedConstructors, resource.type);
    }

    // Import statement
    const imports = [...usedConstructors].sort().join(", ");
    lines.push(`import { ${imports} } from "@intentius/chant-lexicon-k8s";`);
    lines.push("");

    // Emit namespaces as comments
    if (ir.metadata?.namespaces && Array.isArray(ir.metadata.namespaces)) {
      lines.push(`// Namespaces: ${(ir.metadata.namespaces as string[]).join(", ")}`);
      lines.push("");
    }

    // Emit resources
    for (const resource of ir.resources) {
      const cls = this.resolveClass(resource.type);
      if (!cls) {
        lines.push(`// TODO: unsupported type ${resource.type} (${resource.logicalId})`);
        lines.push("");
        continue;
      }

      const varName = resource.logicalId;
      const propsStr = this.emitProps(resource.properties, 1, resource.type);

      lines.push(`export const ${varName} = new ${cls}(${propsStr});`);
      lines.push("");
    }

    return [{ path: "main.ts", content: lines.join("\n") }];
  }

  /**
   * Resolve a K8s type name to a constructor class name.
   * Falls back to extracting the last segment of the type.
   */
  private resolveClass(type: string): string | undefined {
    if (TYPE_TO_CLASS[type]) return TYPE_TO_CLASS[type];

    // Fallback: extract Kind from "K8s::Group::Kind"
    const parts = type.split("::");
    if (parts.length === 3 && parts[0] === "K8s") return parts[2];

    return undefined;
  }

  private collectNestedConstructors(
    props: Record<string, unknown>,
    used: Set<string>,
    parentType: string,
  ): void {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;

      // Special case: "ports" on Service resources → ServicePort
      if (key === "ports" && SERVICE_PORT_TYPES.has(parentType)) {
        if (Array.isArray(value)) used.add("ServicePort");
        continue;
      }

      const constructor = PROPERTY_CONSTRUCTORS[key];
      if (!constructor) continue;

      if (Array.isArray(value)) {
        used.add(constructor);
      } else if (typeof value === "object") {
        used.add(constructor);
      }

      // Recurse into nested specs (e.g., template.spec.containers)
      if (typeof value === "object" && !Array.isArray(value)) {
        this.collectNestedConstructors(value as Record<string, unknown>, used, parentType);
      }
    }

    // Recurse into spec if present
    if (props.spec && typeof props.spec === "object" && !Array.isArray(props.spec)) {
      this.collectNestedConstructors(props.spec as Record<string, unknown>, used, parentType);
    }
  }

  private emitProps(props: Record<string, unknown>, depth: number, parentType: string): string {
    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    const entries: string[] = [];

    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      const emitted = this.emitValue(key, value, depth + 1, parentType);
      entries.push(`${innerIndent}${key}: ${emitted},`);
    }

    if (entries.length === 0) return "{}";
    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private emitValue(key: string, value: unknown, depth: number, parentType: string): string {
    if (value === null || value === undefined) return "undefined";

    // Special case: "ports" on Service → ServicePort constructor
    if (key === "ports" && SERVICE_PORT_TYPES.has(parentType) && Array.isArray(value)) {
      return this.emitConstructorArray("ServicePort", value, depth, parentType);
    }

    // Check if this key maps to a property constructor
    const constructor = PROPERTY_CONSTRUCTORS[key];
    if (constructor) {
      // Array of constructors (containers, volumes, ports, env, etc.)
      if (Array.isArray(value)) {
        return this.emitConstructorArray(constructor, value, depth, parentType);
      }
      // Single constructor (securityContext, resources, selector, template, strategy, etc.)
      if (typeof value === "object") {
        const propsStr = this.emitProps(value as Record<string, unknown>, depth, parentType);
        return `new ${constructor}(${propsStr})`;
      }
    }

    return this.emitLiteral(value, depth, parentType);
  }

  private emitConstructorArray(
    constructor: string,
    items: unknown[],
    depth: number,
    parentType: string,
  ): string {
    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);

    const emitted = items.map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const propsStr = this.emitProps(item as Record<string, unknown>, depth + 1, parentType);
        return `new ${constructor}(${propsStr})`;
      }
      return JSON.stringify(item);
    });

    if (emitted.length === 1 && emitted[0].length < 60) {
      return `[${emitted[0]}]`;
    }
    return `[\n${emitted.map((e) => `${innerIndent}${e},`).join("\n")}\n${indent}]`;
  }

  private emitLiteral(value: unknown, depth: number, parentType: string): string {
    if (value === null || value === undefined) return "undefined";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map((item) => this.emitLiteral(item, depth + 1, parentType));
      const oneLine = `[${items.join(", ")}]`;
      if (oneLine.length < 80) return oneLine;
      const indent = "  ".repeat(depth);
      const innerIndent = "  ".repeat(depth + 1);
      return `[\n${items.map((i) => `${innerIndent}${i},`).join("\n")}\n${indent}]`;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return "{}";
      const indent = "  ".repeat(depth);
      const innerIndent = "  ".repeat(depth + 1);
      const items = entries.map(
        ([k, v]) => `${innerIndent}${k}: ${this.emitLiteral(v, depth + 1, parentType)},`,
      );
      return `{\n${items.join("\n")}\n${indent}}`;
    }

    return String(value);
  }
}
