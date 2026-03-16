/**
 * ARM template JSON parser — converts ARM templates to intermediate representation.
 *
 * Handles ARM bracket expressions: [resourceId(...)], [reference(...)],
 * [parameters(...)], [variables(...)], [concat(...)], etc.
 */

import type {
  TemplateParser,
  TemplateIR,
  ResourceIR,
  ParameterIR,
} from "@intentius/chant/import/parser";
import { BaseValueParser } from "@intentius/chant/import/base-parser";

/**
 * ARM template parser.
 */
export class ArmParser extends BaseValueParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const template = JSON.parse(content);

    if (!template.resources || !Array.isArray(template.resources)) {
      throw new Error("Invalid ARM template: missing resources array");
    }

    const parameters: ParameterIR[] = [];
    const resources: ResourceIR[] = [];

    // Parse parameters
    if (template.parameters) {
      for (const [name, param] of Object.entries(template.parameters)) {
        const p = param as Record<string, unknown>;
        parameters.push({
          name,
          type: mapArmParameterType(p.type as string),
          description: (p.metadata as Record<string, string>)?.description ?? p.description as string,
          default: p.defaultValue,
        });
      }
    }

    // Parse resources
    for (const resource of template.resources) {
      const r = resource as Record<string, unknown>;
      const type = r.type as string;
      const name = r.name as string;

      // Collect all properties including resource-level fields
      const properties: Record<string, unknown> = {};

      // Resource-level fields
      for (const field of ["location", "sku", "kind", "identity", "tags", "zones", "plan"]) {
        if (r[field] !== undefined) {
          properties[field] = this.parseValue(r[field]);
        }
      }

      // Nested properties
      if (r.properties && typeof r.properties === "object") {
        for (const [key, value] of Object.entries(r.properties as Record<string, unknown>)) {
          properties[key] = this.parseValue(value);
        }
      }

      // Parse dependsOn
      const dependsOn = r.dependsOn as string[] | undefined;
      const deps = dependsOn?.map((d) => this.extractResourceName(d)) ?? [];

      resources.push({
        logicalId: name,
        type,
        properties,
        dependsOn: deps.length > 0 ? deps : undefined,
      });
    }

    return {
      parameters,
      resources,
      metadata: {
        format: "arm",
        schema: template.$schema,
        contentVersion: template.contentVersion,
      },
    };
  }

  /**
   * Parse a value, handling ARM bracket expressions.
   */
  parseValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.parseBracketExpression(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.parseValue(v));
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.parseValue(v);
      }
      return result;
    }
    return value;
  }

  /**
   * Parse ARM bracket expressions like [resourceId(...)], [reference(...)], etc.
   */
  private parseBracketExpression(value: string): unknown {
    if (!value.startsWith("[") || !value.endsWith("]")) return value;
    // Escaped bracket
    if (value.startsWith("[[")) return value.slice(1);

    const expr = value.slice(1, -1);

    // resourceId(...)
    const resourceIdMatch = expr.match(/^resourceId\((.+)\)$/);
    if (resourceIdMatch) {
      return { __intrinsic: "ResourceId", args: this.parseArgs(resourceIdMatch[1]) };
    }

    // reference(...)
    const referenceMatch = expr.match(/^reference\((.+)\)$/);
    if (referenceMatch) {
      return { __intrinsic: "Reference", args: this.parseArgs(referenceMatch[1]) };
    }

    // parameters(...)
    const parametersMatch = expr.match(/^parameters\('([^']+)'\)$/);
    if (parametersMatch) {
      return { __intrinsic: "Ref", name: parametersMatch[1] };
    }

    // concat(...)
    const concatMatch = expr.match(/^concat\((.+)\)$/);
    if (concatMatch) {
      return { __intrinsic: "Concat", args: this.parseArgs(concatMatch[1]) };
    }

    // resourceGroup().location, resourceGroup().name, etc.
    const rgMatch = expr.match(/^resourceGroup\(\)\.(\w+)$/);
    if (rgMatch) {
      return { __intrinsic: "ResourceGroup", property: rgMatch[1] };
    }

    // subscription().subscriptionId, etc.
    const subMatch = expr.match(/^subscription\(\)\.(\w+)$/);
    if (subMatch) {
      return { __intrinsic: "Subscription", property: subMatch[1] };
    }

    // uniqueString(...)
    const uniqueMatch = expr.match(/^uniqueString\((.+)\)$/);
    if (uniqueMatch) {
      return { __intrinsic: "UniqueString", args: this.parseArgs(uniqueMatch[1]) };
    }

    // Return raw expression as-is
    return value;
  }

  /**
   * Parse comma-separated args from a function call string.
   */
  private parseArgs(argsStr: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of argsStr) {
      if (char === "(" ) depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        args.push(current.trim().replace(/^'|'$/g, ""));
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) {
      args.push(current.trim().replace(/^'|'$/g, ""));
    }
    return args;
  }

  /**
   * Extract a resource name from a dependsOn resourceId expression.
   */
  private extractResourceName(dep: string): string {
    if (dep.startsWith("[")) {
      // Try to extract from resourceId expression
      const match = dep.match(/resourceId\([^,]+,\s*'([^']+)'\)/);
      if (match) return match[1];
    }
    return dep;
  }
}

function mapArmParameterType(type: string): string {
  switch (type?.toLowerCase()) {
    case "string": return "String";
    case "int": return "Number";
    case "bool": return "String";
    case "array": return "CommaDelimitedList";
    case "object": return "String";
    case "securestring": return "String";
    default: return "String";
  }
}
