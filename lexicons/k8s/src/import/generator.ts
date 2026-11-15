/**
 * TypeScript code generator for Kubernetes import.
 *
 * Converts a TemplateIR (from parsed K8s manifests) into TypeScript
 * source code using the @intentius/chant-lexicon-k8s constructors.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import {
  EmbeddedImportScope,
  isEmbeddedReference,
  renderEmbeddedReference,
} from "@intentius/chant/import/embedded";
import { SECRET_DECLARATION_ENTITY_TYPE } from "@intentius/chant/secret-provenance";
import { isMaskedValueRef } from "../index-import";
import { importClassFor } from "./typed-classes";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object key as TypeScript: bare when it is an identifier, quoted otherwise (`"config.yaml"`, `"app.kubernetes.io/name"`). */
function propertyKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

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
 * A Role's and a ClusterRole's top-level `rules` are PolicyRules, not the
 * IngressRules {@link PROPERTY_CONSTRUCTORS} maps `rules` to. Since the
 * property classes carry their members (chant #3093), an IngressRule built
 * from `apiGroups`/`verbs` no longer type-checks.
 */
const POLICY_RULE_TYPES = new Set([
  "K8s::Rbac::Role",
  "K8s::Rbac::ClusterRole",
]);

/** The constructor for `key` on a resource of `parentType`. */
function constructorFor(key: string, parentType: string): string | undefined {
  if (key === "rules" && POLICY_RULE_TYPES.has(parentType)) return "PolicyRule";
  return PROPERTY_CONSTRUCTORS[key];
}

/**
 * Generate TypeScript source code from a Kubernetes IR.
 */
export class K8sGenerator implements TypeScriptGenerator {
  /** The imports for embedded content the current `generate()` call references (#2962). */
  private scope = new EmbeddedImportScope("");

  /** Whether the current `generate()` call wrote a `maskedValue(...)` (chant import --index, #4538). */
  private usesMaskedValue = false;

  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];
    this.usesMaskedValue = false;
    let usesDeclareSecret = false;
    let usesManifest = false;

    // Collect which constructors are needed
    const usedConstructors = new Set<string>();
    for (const resource of ir.resources) {
      const cls = this.resolveClass(resource);
      if (!cls) continue;
      usedConstructors.add(cls);

      // Check properties for nested constructors
      this.collectNestedConstructors(resource.properties, usedConstructors, resource.type);
    }

    // Names the embedded content's imports must not take: every constructor this file may use, and its exports.
    this.scope = new EmbeddedImportScope("", [
      ...usedConstructors,
      ...Object.values(PROPERTY_CONSTRUCTORS),
      "ServicePort",
      "PolicyRule",
      ...ir.resources.map((r) => r.logicalId),
    ]);

    // Emit namespaces as comments
    if (ir.metadata?.namespaces && Array.isArray(ir.metadata.namespaces)) {
      lines.push(`// Namespaces: ${(ir.metadata.namespaces as string[]).join(", ")}`);
      lines.push("");
    }

    // Emit resources
    for (const resource of ir.resources) {
      // A Secret `chant import --index` read masked: a referenced secret the user supplies (#4538).
      if (resource.type === SECRET_DECLARATION_ENTITY_TYPE) {
        usesDeclareSecret = true;
        lines.push(`export const ${resource.logicalId} = declareSecret(${this.emitLiteral(resource.properties, 0, resource.type)});`);
        lines.push("");
        continue;
      }
      const cls = this.resolveClass(resource);
      if (!cls) {
        const manifest = this.emitManifest(resource);
        if (manifest) {
          usesManifest = true;
          lines.push(`export const ${resource.logicalId} = ${manifest};`);
          lines.push("");
          continue;
        }
        lines.push(`// TODO: unsupported type ${resource.type} (${resource.logicalId})`);
        lines.push("");
        continue;
      }

      const varName = resource.logicalId;
      const propsStr = this.emitProps(resource.properties, 1, resource.type);

      lines.push(`export const ${varName} = new ${cls}(${propsStr});`);
      lines.push("");
    }

    // Import statements: the k8s constructors, then what embedded content references.
    // The constructors are read back from what was emitted (string literals
    // taken out), so a nested one the walk above does not reach (a
    // container's env) is imported too.
    const code = lines.join("\n").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    for (const m of code.matchAll(/\bnew ([A-Z][A-Za-z0-9_]*)\(/g)) usedConstructors.add(m[1]);
    const imports = [...(usesManifest ? ["k8sManifest"] : []), ...[...usedConstructors].sort()].join(", ");
    const head = [
      ...(usesDeclareSecret ? [`import { declareSecret } from "@intentius/chant";`] : []),
      ...(imports ? [`import { ${imports} } from "@intentius/chant-lexicon-k8s";`] : []),
      ...this.scope.lines(),
      "",
    ];
    if (this.usesMaskedValue) head.push(...this.maskedValueHelper(ir), "");

    return [{ path: "main.ts", content: [...head, ...lines].join("\n") }];
  }

  /**
   * The helper a value masked in the index reads its environment variable
   * through, with the parameters it stands for listed above it.
   */
  private maskedValueHelper(ir: TemplateIR): string[] {
    return [
      "// Values the index masked. Set each environment variable before building:",
      ...ir.parameters.map((p) => `//   ${p.name}: ${(p.description ?? "").replace(/\r?\n/g, " ")}`),
      "function maskedValue(name: string): any {",
      "  const raw = process.env[name];",
      "  if (raw === undefined) throw new Error(`${name} is not set: the value was masked in the index`);",
      "  return /^\\s*[[{]/.test(raw) ? JSON.parse(raw) : raw;",
      "}",
    ];
  }

  /**
   * Resolve a resource to a constructor class name, or undefined when the
   * lexicon exports none or the class builds another apiVersion than the
   * resource has (the resource is written as a `k8sManifest`, see
   * `importClassFor`).
   */
  private resolveClass(resource: ResourceIR): string | undefined {
    return importClassFor(resource).cls;
  }

  /**
   * An untyped resource: the whole manifest handed to `k8sManifest`, which
   * the serializer writes as given. Property constructors do not apply, the
   * kind's schema is unknown. Undefined when the apiVersion or kind cannot
   * be found.
   */
  private emitManifest(resource: ResourceIR): string | undefined {
    const meta = resource.metadata ?? {};
    const apiVersion = meta.apiVersion ?? resource.properties.apiVersion;
    const kind = meta.kind ?? resource.type.split("::").pop();
    if (typeof apiVersion !== "string" || typeof kind !== "string") return undefined;
    const rest = { ...resource.properties };
    delete rest.apiVersion;
    return `k8sManifest(${this.emitLiteral({ apiVersion, kind, ...rest }, 0, resource.type)})`;
  }

  private collectNestedConstructors(
    props: Record<string, unknown>,
    used: Set<string>,
    parentType: string,
  ): void {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || isMaskedValueRef(value)) continue;

      // Special case: "ports" on Service resources → ServicePort
      if (key === "ports" && SERVICE_PORT_TYPES.has(parentType)) {
        if (Array.isArray(value)) used.add("ServicePort");
        continue;
      }

      const constructor = constructorFor(key, parentType);
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
      entries.push(`${innerIndent}${propertyKey(key)}: ${emitted},`);
    }

    if (entries.length === 0) return "{}";
    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private emitValue(key: string, value: unknown, depth: number, parentType: string): string {
    if (value === null || value === undefined) return "undefined";
    if (isEmbeddedReference(value)) return renderEmbeddedReference(value, this.scope, depth * 2);
    if (isMaskedValueRef(value)) return this.emitLiteral(value, depth, parentType);

    // Special case: "ports" on Service → ServicePort constructor
    if (key === "ports" && SERVICE_PORT_TYPES.has(parentType) && Array.isArray(value)) {
      return this.emitConstructorArray("ServicePort", value, depth, parentType);
    }

    // Check if this key maps to a property constructor
    const constructor = constructorFor(key, parentType);
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
      if (isMaskedValueRef(item)) return this.emitLiteral(item, depth + 1, parentType);
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
    if (isEmbeddedReference(value)) return renderEmbeddedReference(value, this.scope, depth * 2);
    if (isMaskedValueRef(value)) {
      this.usesMaskedValue = true;
      return `maskedValue(${JSON.stringify(value.__k8sMaskedValue)})`;
    }
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
        ([k, v]) => `${innerIndent}${propertyKey(k)}: ${this.emitLiteral(v, depth + 1, parentType)},`,
      );
      return `{\n${items.join("\n")}\n${indent}}`;
    }

    return String(value);
  }
}
