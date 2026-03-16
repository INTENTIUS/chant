/**
 * Flyway TypeScript code generator.
 *
 * Converts template IR to TypeScript source files that use Flyway lexicon types.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

/**
 * Map resource types to their TypeScript class names.
 */
const TYPE_TO_CLASS: Record<string, string> = {
  "Flyway::Project": "FlywayProject",
  "Flyway::Config": "FlywayConfig",
  "Flyway::Environment": "Environment",
  "Flyway::FlywayDesktop": "FlywayDesktopConfig",
  "Flyway::RedgateCompare": "RedgateCompareConfig",
  "Flyway::Resolver.Vault": "VaultResolver",
  "Flyway::Resolver.Gcp": "GcpResolver",
  "Flyway::Resolver.Dapr": "DaprResolver",
  "Flyway::Resolver.Clone": "CloneResolver",
  "Flyway::Resolver.AzureAd": "AzureAdResolver",
  "Flyway::Resolver.Env": "EnvResolver",
  "Flyway::Resolver.Git": "GitResolver",
  "Flyway::Resolver.LocalSecret": "LocalSecretResolver",
};

/**
 * Generate TypeScript code from Flyway template IR.
 */
export class FlywayGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const imports = new Set<string>();
    const declarations: string[] = [];

    for (const resource of ir.resources) {
      const className = TYPE_TO_CLASS[resource.type];
      if (!className) continue;
      imports.add(className);

      const varName = sanitizeVarName(resource.logicalId);
      const propsStr = formatProps(resource.properties, 1);

      declarations.push(
        `export const ${varName} = new ${className}(${propsStr});`,
      );
    }

    const importLine = imports.size > 0
      ? `import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-flyway";\n\n`
      : "";

    const content = importLine + declarations.join("\n\n") + "\n";

    return [{ path: "src/infra.ts", content }];
  }
}

function sanitizeVarName(name: string): string {
  // Convert kebab-case or snake_case to camelCase
  return name
    .replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function formatProps(props: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(props).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";

  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);

  const lines = entries.map(([key, value]) => {
    return `${innerPad}${key}: ${formatValue(value, indent + 1)},`;
  });

  return `{\n${lines.join("\n")}\n${pad}}`;
}

function formatValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    const pad = "  ".repeat(indent);
    const innerPad = "  ".repeat(indent + 1);
    const items = value.map((v) => `${innerPad}${formatValue(v, indent + 1)},`);
    return `[\n${items.join("\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    return formatProps(value as Record<string, unknown>, indent);
  }

  return String(value);
}
