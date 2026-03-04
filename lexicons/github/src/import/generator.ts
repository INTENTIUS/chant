/**
 * TypeScript code generator for GitHub Actions import.
 *
 * Converts a TemplateIR into TypeScript source code using
 * the @intentius/chant-lexicon-github constructors.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

const TYPE_TO_CLASS: Record<string, string> = {
  "GitHub::Actions::Workflow": "Workflow",
  "GitHub::Actions::Job": "Job",
  "GitHub::Actions::ReusableWorkflowCallJob": "ReusableWorkflowCallJob",
};

const PROPERTY_CONSTRUCTORS: Record<string, string> = {
  strategy: "Strategy",
  concurrency: "Concurrency",
  container: "Container",
  environment: "Environment",
  permissions: "Permissions",
  defaults: "Defaults",
};

/**
 * Generate TypeScript source code from a GitHub Actions IR.
 */
export class GitHubActionsGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    const usedConstructors = new Set<string>();
    for (const resource of ir.resources) {
      const cls = TYPE_TO_CLASS[resource.type];
      if (cls) usedConstructors.add(cls);
      this.collectNestedConstructors(resource.properties, usedConstructors);
    }

    const imports = [...usedConstructors].sort().join(", ");
    lines.push(`import { ${imports} } from "@intentius/chant-lexicon-github";`);
    lines.push("");

    for (const resource of ir.resources) {
      const cls = TYPE_TO_CLASS[resource.type];
      if (!cls) continue;

      const varName = resource.logicalId;
      const propsStr = this.emitProps(resource.properties, 1);
      lines.push(`export const ${varName} = new ${cls}(${propsStr});`);
      lines.push("");
    }

    return [{ path: "main.ts", content: lines.join("\n") }];
  }

  private collectNestedConstructors(props: Record<string, unknown>, used: Set<string>): void {
    for (const [key, value] of Object.entries(props)) {
      const constructor = PROPERTY_CONSTRUCTORS[key];
      if (constructor && typeof value === "object" && value !== null && !Array.isArray(value)) {
        used.add(constructor);
      }
    }
  }

  private emitProps(props: Record<string, unknown>, depth: number): string {
    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    const entries: string[] = [];

    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      const emitted = this.emitValue(key, value, depth + 1);
      entries.push(`${innerIndent}${JSON.stringify(key)}: ${emitted},`);
    }

    if (entries.length === 0) return "{}";
    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private emitValue(key: string, value: unknown, depth: number): string {
    if (value === null || value === undefined) return "undefined";

    const constructor = PROPERTY_CONSTRUCTORS[key];
    if (constructor && typeof value === "object" && !Array.isArray(value)) {
      const propsStr = this.emitProps(value as Record<string, unknown>, depth);
      return `new ${constructor}(${propsStr})`;
    }

    return this.emitLiteral(value, depth);
  }

  private emitLiteral(value: unknown, depth: number): string {
    if (value === null || value === undefined) return "undefined";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map((item) => this.emitLiteral(item, depth + 1));
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
      const items = entries.map(([k, v]) => `${innerIndent}${JSON.stringify(k)}: ${this.emitLiteral(v, depth + 1)},`);
      return `{\n${items.join("\n")}\n${indent}}`;
    }

    return String(value);
  }
}
