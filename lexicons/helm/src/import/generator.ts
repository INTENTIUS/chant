/**
 * TypeScript code generator for Helm chart import.
 *
 * Converts a TemplateIR (from parsed Helm charts) into TypeScript source code
 * using @intentius/chant-lexicon-helm and @intentius/chant-lexicon-k8s constructors,
 * mapping Go template expressions to Helm intrinsics.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import type { ExpressionKind } from "./template-stripper";

/** K8s type to class name mapping. */
const K8S_TYPE_TO_CLASS: Record<string, string> = {
  "K8s::Core::Pod": "Pod",
  "K8s::Core::Service": "Service",
  "K8s::Core::ConfigMap": "ConfigMap",
  "K8s::Core::Secret": "Secret",
  "K8s::Core::ServiceAccount": "ServiceAccount",
  "K8s::Apps::Deployment": "Deployment",
  "K8s::Apps::StatefulSet": "StatefulSet",
  "K8s::Apps::DaemonSet": "DaemonSet",
  "K8s::Batch::Job": "Job",
  "K8s::Batch::CronJob": "CronJob",
  "K8s::Networking::Ingress": "Ingress",
  "K8s::Networking::NetworkPolicy": "NetworkPolicy",
  "K8s::Rbac::Role": "Role",
  "K8s::Rbac::ClusterRole": "ClusterRole",
  "K8s::Rbac::RoleBinding": "RoleBinding",
  "K8s::Rbac::ClusterRoleBinding": "ClusterRoleBinding",
  "K8s::Autoscaling::HorizontalPodAutoscaler": "HorizontalPodAutoscaler",
  "K8s::Policy::PodDisruptionBudget": "PodDisruptionBudget",
};

/** Helm type to class name mapping. */
const HELM_TYPE_TO_CLASS: Record<string, string> = {
  "Helm::Chart": "Chart",
  "Helm::Values": "Values",
  "Helm::Notes": "HelmNotes",
};

export class HelmGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];
    const helmImports = new Set<string>();
    const k8sImports = new Set<string>();
    const intrinsicImports = new Set<string>();

    // Classify resources and collect needed imports
    for (const resource of ir.resources) {
      const helmClass = HELM_TYPE_TO_CLASS[resource.type];
      if (helmClass) {
        helmImports.add(helmClass);
      } else {
        const k8sClass = this.resolveK8sClass(resource.type);
        if (k8sClass) k8sImports.add(k8sClass);
      }

      // Scan for template expressions to determine intrinsic imports
      this.collectIntrinsicImports(resource, intrinsicImports);
    }

    // Emit imports
    if (helmImports.size > 0) {
      lines.push(`import { ${[...helmImports].sort().join(", ")} } from "@intentius/chant-lexicon-helm";`);
    }
    if (intrinsicImports.size > 0) {
      lines.push(`import { ${[...intrinsicImports].sort().join(", ")} } from "@intentius/chant-lexicon-helm";`);
    }
    if (k8sImports.size > 0) {
      lines.push(`import { ${[...k8sImports].sort().join(", ")} } from "@intentius/chant-lexicon-k8s";`);
    }
    lines.push("");

    // Emit resources
    for (const resource of ir.resources) {
      const cls = HELM_TYPE_TO_CLASS[resource.type] ?? this.resolveK8sClass(resource.type);
      if (!cls) {
        lines.push(`// TODO: unsupported type ${resource.type} (${resource.logicalId})`);
        lines.push("");
        continue;
      }

      // Replace placeholders with intrinsic calls in properties
      const props = this.substituteExpressions(resource.properties, resource.metadata?.templateExpressions as Record<string, { expression: string; kind: string }> | undefined);
      const propsStr = this.emitProps(props, 1);

      lines.push(`export const ${resource.logicalId} = new ${cls}(${propsStr});`);
      lines.push("");
    }

    return [{ path: "chart.ts", content: lines.join("\n") }];
  }

  private resolveK8sClass(type: string): string | undefined {
    if (K8S_TYPE_TO_CLASS[type]) return K8S_TYPE_TO_CLASS[type];
    const parts = type.split("::");
    if (parts.length === 3 && parts[0] === "K8s") return parts[2];
    return undefined;
  }

  private collectIntrinsicImports(resource: ResourceIR, imports: Set<string>): void {
    const exprs = resource.metadata?.templateExpressions as Record<string, { expression: string; kind: string }> | undefined;
    if (!exprs) return;

    for (const entry of Object.values(exprs)) {
      const kind = entry.kind as ExpressionKind;
      switch (kind) {
        case "values": imports.add("values"); break;
        case "release": imports.add("Release"); break;
        case "chart": imports.add("ChartRef"); break;
        case "include": imports.add("include"); break;
        case "toYaml": imports.add("toYaml"); imports.add("values"); break;
        case "required": imports.add("required"); imports.add("values"); break;
        case "default": imports.add("helmDefault"); imports.add("values"); break;
        case "printf": imports.add("printf"); break;
        case "quote": imports.add("quote"); imports.add("values"); break;
        case "lookup": imports.add("lookup"); break;
        case "tpl": imports.add("tpl"); break;
      }
    }
  }

  /**
   * Walk through properties, replacing placeholder strings with intrinsic call representations.
   */
  private substituteExpressions(
    props: Record<string, unknown>,
    exprs: Record<string, { expression: string; kind: string }> | undefined,
  ): Record<string, unknown> {
    if (!exprs) return props;
    return this.walkAndReplace(props, exprs) as Record<string, unknown>;
  }

  private walkAndReplace(
    value: unknown,
    exprs: Record<string, { expression: string; kind: string }>,
  ): unknown {
    if (typeof value === "string") {
      // Check if the entire string is a placeholder
      const expr = exprs[value];
      if (expr) {
        return { __intrinsicCall: this.expressionToIntrinsic(expr.expression, expr.kind as ExpressionKind) };
      }
      // Check if the string contains placeholders mixed with text
      let result = value;
      for (const [placeholder, entry] of Object.entries(exprs)) {
        if (result.includes(placeholder)) {
          result = result.replace(placeholder, `\${${this.expressionToIntrinsic(entry.expression, entry.kind as ExpressionKind)}}`);
        }
      }
      if (result !== value) {
        return { __intrinsicCall: result };
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.walkAndReplace(item, exprs));
    }

    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.walkAndReplace(v, exprs);
      }
      return result;
    }

    return value;
  }

  /**
   * Convert a Go template expression to a TypeScript intrinsic call string.
   */
  private expressionToIntrinsic(expression: string, kind: ExpressionKind): string {
    switch (kind) {
      case "values": {
        const path = expression.replace(/^\.Values\./, "");
        return `values.${path}`;
      }
      case "release": {
        const field = expression.replace(/^\.Release\./, "");
        return `Release.${field}`;
      }
      case "chart": {
        const field = expression.replace(/^\.Chart\./, "");
        return `ChartRef.${field}`;
      }
      case "include": {
        const match = expression.match(/^include\s+"([^"]+)"\s+(.+)$/);
        if (match) return `include("${match[1]}")`;
        return `include(${JSON.stringify(expression)})`;
      }
      case "toYaml": {
        const match = expression.match(/toYaml\s+(.+?)(?:\s*\|\s*nindent\s+(\d+))?$/);
        if (match) {
          const ref = this.refToIntrinsic(match[1]);
          return match[2] ? `toYaml(${ref}, ${match[2]})` : `toYaml(${ref})`;
        }
        return `toYaml(${JSON.stringify(expression)})`;
      }
      case "required": {
        const match = expression.match(/^required\s+"([^"]+)"\s+(.+)$/);
        if (match) return `required("${match[1]}", ${this.refToIntrinsic(match[2])})`;
        return `required(${JSON.stringify(expression)})`;
      }
      case "default": {
        const match = expression.match(/^default\s+"([^"]+)"\s+(.+)$/);
        if (match) return `helmDefault("${match[1]}", ${this.refToIntrinsic(match[2])})`;
        return `helmDefault(${JSON.stringify(expression)})`;
      }
      case "printf": {
        const match = expression.match(/^printf\s+"([^"]+)"\s+(.+)$/);
        if (match) {
          const args = match[2].split(/\s+/).map((a) => this.refToIntrinsic(a));
          return `printf("${match[1]}", ${args.join(", ")})`;
        }
        return `printf(${JSON.stringify(expression)})`;
      }
      case "quote":
        return `quote(${this.refToIntrinsic(expression.replace(/\s*\|\s*quote\s*$/, ""))})`;
      case "lookup":
        return `lookup(${JSON.stringify(expression)})`;
      case "tpl":
        return `tpl(${JSON.stringify(expression)})`;
      default:
        return `/* ${expression} */`;
    }
  }

  /**
   * Convert a Go template reference to a TypeScript expression.
   */
  private refToIntrinsic(ref: string): string {
    const trimmed = ref.trim();
    if (trimmed.startsWith(".Values.")) return `values.${trimmed.slice(8)}`;
    if (trimmed.startsWith(".Release.")) return `Release.${trimmed.slice(9)}`;
    if (trimmed.startsWith(".Chart.")) return `ChartRef.${trimmed.slice(7)}`;
    if (trimmed === ".") return "context";
    return JSON.stringify(trimmed);
  }

  private emitProps(props: Record<string, unknown>, depth: number): string {
    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    const entries: string[] = [];

    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      entries.push(`${innerIndent}${key}: ${this.emitValue(value, depth + 1)},`);
    }

    if (entries.length === 0) return "{}";
    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private emitValue(value: unknown, depth: number): string {
    if (value === null || value === undefined) return "undefined";

    // Intrinsic call placeholder
    if (typeof value === "object" && value !== null && "__intrinsicCall" in value) {
      return (value as { __intrinsicCall: string }).__intrinsicCall;
    }

    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map((item) => this.emitValue(item, depth + 1));
      const oneLine = `[${items.join(", ")}]`;
      if (oneLine.length < 80) return oneLine;
      const indent = "  ".repeat(depth);
      const innerIndent = "  ".repeat(depth + 1);
      return `[\n${items.map((i) => `${innerIndent}${i},`).join("\n")}\n${indent}]`;
    }

    if (typeof value === "object") {
      return this.emitProps(value as Record<string, unknown>, depth);
    }

    return String(value);
  }
}
