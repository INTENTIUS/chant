/**
 * TypeScript code generator for GitLab CI import.
 *
 * Converts a TemplateIR (from parsed .gitlab-ci.yml) into TypeScript
 * source code using the @intentius/chant-lexicon-gitlab constructors.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

/**
 * Map GitLab CI entity types to their constructor names.
 */
const TYPE_TO_CLASS: Record<string, string> = {
  "GitLab::CI::Job": "Job",
  "GitLab::CI::Default": "Default",
  "GitLab::CI::Workflow": "Workflow",
};

/**
 * Properties that reference known property entities.
 */
const PROPERTY_CONSTRUCTORS: Record<string, string> = {
  artifacts: "Artifacts",
  cache: "Cache",
  image: "Image",
  retry: "Retry",
  allowFailure: "AllowFailure",
  parallel: "Parallel",
  environment: "Environment",
  trigger: "Trigger",
  autoCancel: "AutoCancel",
};

/**
 * Generate TypeScript source code from a GitLab CI IR.
 */
export class GitLabGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    // Collect which constructors are needed
    const usedConstructors = new Set<string>();
    for (const resource of ir.resources) {
      const cls = TYPE_TO_CLASS[resource.type];
      if (cls) usedConstructors.add(cls);

      // Check properties for nested constructors
      this.collectNestedConstructors(resource.properties, usedConstructors);
    }

    // Import statement
    const imports = [...usedConstructors].sort().join(", ");
    lines.push(`import { ${imports} } from "@intentius/chant-lexicon-gitlab";`);
    lines.push("");

    // Emit stages if present in metadata
    if (ir.metadata?.stages && Array.isArray(ir.metadata.stages)) {
      lines.push(`// Pipeline stages: ${(ir.metadata.stages as string[]).join(", ")}`);
      lines.push("");
    }

    // Emit includes as comments
    if (ir.metadata?.include) {
      lines.push("// Imported includes (not converted):");
      const includes = Array.isArray(ir.metadata.include) ? ir.metadata.include : [ir.metadata.include];
      for (const inc of includes) {
        if (typeof inc === "string") {
          lines.push(`//   - ${inc}`);
        } else if (typeof inc === "object" && inc !== null) {
          lines.push(`//   - ${JSON.stringify(inc)}`);
        }
      }
      lines.push("");
    }

    // Emit resources
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
      if (key === "rules" && Array.isArray(value)) {
        used.add("Rule");
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
      entries.push(`${innerIndent}${key}: ${emitted},`);
    }

    if (entries.length === 0) return "{}";
    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private emitValue(key: string, value: unknown, depth: number): string {
    if (value === null || value === undefined) return "undefined";

    // Check if this key maps to a property constructor
    const constructor = PROPERTY_CONSTRUCTORS[key];
    if (constructor && typeof value === "object" && !Array.isArray(value)) {
      const propsStr = this.emitProps(value as Record<string, unknown>, depth);
      return `new ${constructor}(${propsStr})`;
    }

    // Rules array — wrap each item in Rule constructor
    if (key === "rules" && Array.isArray(value)) {
      const items = value.map((item) => {
        if (typeof item === "object" && item !== null) {
          const propsStr = this.emitProps(item as Record<string, unknown>, depth + 1);
          return `new Rule(${propsStr})`;
        }
        return JSON.stringify(item);
      });
      const indent = "  ".repeat(depth);
      const innerIndent = "  ".repeat(depth + 1);
      return `[\n${items.map((i) => `${innerIndent}${i},`).join("\n")}\n${indent}]`;
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
      // Short arrays on one line
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
      const items = entries.map(([k, v]) => `${innerIndent}${k}: ${this.emitLiteral(v, depth + 1)},`);
      return `{\n${items.join("\n")}\n${indent}}`;
    }

    return String(value);
  }
}
