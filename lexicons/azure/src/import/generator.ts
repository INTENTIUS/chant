/**
 * ARM template → TypeScript code generator.
 *
 * Converts intermediate representation to idiomatic chant TypeScript.
 */

import { loadLexiconRegistry } from "@intentius/chant/codegen/registry";
import { createRequire } from "module";
import type { TemplateIR, ResourceIR, ParameterIR } from "@intentius/chant/import/parser";
const require = createRequire(import.meta.url);
import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import { join } from "path";
import { armType } from "../arm-type";

/** Intrinsics the generator writes as calls, which the file then imports. */
const CALL_INTRINSICS = new Set(["ResourceId", "Reference", "Concat", "UniqueString"]);

/**
 * TypeScript code generator for ARM templates.
 */
export class ArmGenerator implements TypeScriptGenerator {
  private typeToClass: Map<string, string>;

  constructor() {
    this.typeToClass = new Map();
    // Was a silent catch, which left this map empty and made the import emit
    // `// Unknown resource type: Microsoft.…` — indistinguishable from a
    // genuine coverage gap in the lexicon. A missing registry now says so
    // (#1367).
    // A child type is keyed both ways: the lexicon's kind
    // (`Microsoft.Network/virtualNetworks_subnets`, what an index import
    // writes) and ARM's type (`.../virtualNetworks/subnets`, what a template
    // holds), so a subnet is written as a Subnet rather than an unknown type
    // (#5264).
    const meta = loadLexiconRegistry(join(import.meta.dirname, "../.."), "azure");
    for (const [className, entry] of Object.entries(meta)) {
      if (entry.kind !== "resource") continue;
      this.typeToClass.set(entry.resourceType, className);
      const arm = armType(entry.resourceType);
      if (!this.typeToClass.has(arm)) this.typeToClass.set(arm, className);
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
      this.collectIntrinsics(resource.properties, importedIntrinsics);
    }

    if (ir.parameters.length > 0) importedClasses.add("Parameter");

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

    // Parameters, each an export whose name is the template's parameter name.
    for (const param of ir.parameters) {
      const options: string[] = [];
      if (param.description) options.push(`description: ${JSON.stringify(param.description)}`);
      if (param.defaultValue !== undefined) options.push(`defaultValue: ${this.generateValue(param.defaultValue, 1)}`);
      const args = [JSON.stringify(param.type), ...(options.length > 0 ? [`{ ${options.join(", ")} }`] : [])];
      lines.push(`export const ${this.toVarName(param.name)} = new Parameter(${args.join(", ")});`);
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
      const k = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      entries.push(`${innerIndent}${k}: ${this.generateValue(value, depth + 1)},`);
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

  private collectIntrinsics(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const v of value) this.collectIntrinsics(v, into);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.__intrinsic === "string" && CALL_INTRINSICS.has(obj.__intrinsic)) into.add(obj.__intrinsic);
    for (const v of Object.values(obj)) this.collectIntrinsics(v, into);
  }

  private hasAzurePseudo(props: Record<string, unknown>): boolean {
    const json = JSON.stringify(props);
    return json.includes("resourceGroup()") || json.includes("subscription()");
  }
}
