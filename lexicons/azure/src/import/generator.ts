/**
 * ARM template → TypeScript code generator.
 *
 * Converts intermediate representation to idiomatic chant TypeScript.
 */

import { createRequire } from "module";
import type { TemplateIR, ResourceIR, ParameterIR } from "@intentius/chant/import/parser";
const require = createRequire(import.meta.url);
import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import { join } from "path";

/**
 * TypeScript code generator for ARM templates.
 */
export class ArmGenerator implements TypeScriptGenerator {
  private typeToClass: Map<string, string>;

  constructor() {
    this.typeToClass = new Map();
    try {
      const metaPath = join(import.meta.dir, "../../dist/meta.json");
      const meta: Record<string, { resourceType: string; kind: string }> = require(metaPath);
      for (const [className, entry] of Object.entries(meta)) {
        if (entry.kind === "resource" && !className.includes("_")) {
          this.typeToClass.set(entry.resourceType, className);
        }
      }
    } catch {
      // Meta not available
    }
  }

  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    // Collect imports
    const importedClasses = new Set<string>();
    const importedIntrinsics = new Set<string>();
    let needsAzure = false;

    for (const resource of ir.resources) {
      const cls = this.typeToClass.get(resource.type);
      if (cls) importedClasses.add(cls);

      // Check for Azure pseudo-parameters in values
      if (this.hasAzurePseudo(resource.properties)) {
        needsAzure = true;
      }
    }

    if (ir.parameters.length > 0) {
      // Parameters would need a Parameter import from core
    }

    // Build import statement
    const symbols: string[] = [...importedClasses].sort();
    if (importedIntrinsics.size > 0) {
      symbols.push(...[...importedIntrinsics].sort());
    }
    if (needsAzure) {
      symbols.push("Azure");
    }

    if (symbols.length > 0) {
      lines.push(`import { ${symbols.join(", ")} } from "@intentius/chant-lexicon-azure";`);
      lines.push("");
    }

    // Generate resources
    for (const resource of ir.resources) {
      const cls = this.typeToClass.get(resource.type);
      const varName = this.toVarName(resource.logicalId);

      if (cls) {
        lines.push(`export const ${varName} = new ${cls}(${this.generateProps(resource.properties, 1)});`);
      } else {
        lines.push(`// Unknown resource type: ${resource.type}`);
        lines.push(`// export const ${varName} = new ${resource.type}(${this.generateProps(resource.properties, 1)});`);
      }
      lines.push("");
    }

    return [
      {
        path: "main.ts",
        content: lines.join("\n") + "\n",
      },
    ];
  }

  private toVarName(name: string): string {
    // Convert to camelCase
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  private generateProps(props: Record<string, unknown>, depth: number): string {
    if (!props || Object.keys(props).length === 0) return "{}";

    const indent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    const entries: string[] = [];

    for (const [key, value] of Object.entries(props)) {
      entries.push(`${innerIndent}${key}: ${this.generateValue(value, depth + 1)},`);
    }

    return `{\n${entries.join("\n")}\n${indent}}`;
  }

  private generateValue(value: unknown, depth: number): string {
    if (value === null || value === undefined) return "undefined";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map((v) => this.generateValue(v, depth + 1));
      return `[${items.join(", ")}]`;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;

      // Handle intrinsic markers
      if ("__intrinsic" in obj) {
        return this.generateIntrinsic(obj);
      }

      return this.generateProps(obj, depth);
    }
    return String(value);
  }

  private generateIntrinsic(obj: Record<string, unknown>): string {
    const name = obj.__intrinsic as string;

    switch (name) {
      case "ResourceGroup":
        return `Azure.ResourceGroup${(obj.property as string)?.charAt(0).toUpperCase()}${(obj.property as string)?.slice(1)}`;
      case "Subscription":
        return `Azure.SubscriptionId`;
      case "Ref":
        return obj.name as string;
      case "ResourceId":
        return `ResourceId(${(obj.args as string[]).map((a) => JSON.stringify(a)).join(", ")})`;
      case "Reference":
        return `Reference(${(obj.args as string[]).map((a) => JSON.stringify(a)).join(", ")})`;
      case "Concat":
        return `Concat(${(obj.args as string[]).map((a) => JSON.stringify(a)).join(", ")})`;
      case "UniqueString":
        return `UniqueString(${(obj.args as string[]).map((a) => JSON.stringify(a)).join(", ")})`;
      default:
        return JSON.stringify(obj);
    }
  }

  private hasAzurePseudo(props: Record<string, unknown>): boolean {
    const json = JSON.stringify(props);
    return json.includes("resourceGroup()") || json.includes("subscription()");
  }
}
