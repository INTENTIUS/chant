/**
 * Config Connector TypeScript generator.
 *
 * Converts import IR from the parser into typed chant TypeScript code.
 */

import type { TypeScriptGenerator, TemplateIR } from "@intentius/chant/import/generator";

export class GcpGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): string {
    const lines: string[] = [];
    const imports = new Set<string>();

    // Collect imports
    for (const resource of ir.resources) {
      const parts = resource.type.split("::");
      if (parts.length >= 3) {
        // Use the short name for the import
        imports.add(parts[2]);
      }
    }

    if (imports.size > 0) {
      lines.push(
        `import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-gcp";`,
      );
      lines.push("");
    }

    // Generate resource declarations
    for (const resource of ir.resources) {
      const parts = resource.type.split("::");
      const className = parts.length >= 3 ? parts[2] : resource.type;
      const varName = camelCase(resource.logicalName);

      lines.push(`export const ${varName} = new ${className}(${formatProps(resource.properties, 0)});`);
      lines.push("");
    }

    return lines.join("\n");
  }
}

function camelCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toLowerCase());
}

function formatProps(props: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "{}";

  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);

  const lines = entries.map(([key, value]) => {
    return `${pad}${key}: ${formatValue(value, indent + 1)},`;
  });

  return `{\n${lines.join("\n")}\n${closePad}}`;
}

function formatValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const items = value.map((v) => `${pad}${formatValue(v, indent + 1)},`);
    return `[\n${items.join("\n")}\n${closePad}]`;
  }

  if (typeof value === "object") {
    return formatProps(value as Record<string, unknown>, indent);
  }

  return String(value);
}
