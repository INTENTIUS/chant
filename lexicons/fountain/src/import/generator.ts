/**
 * Fountain TypeScript generator.
 *
 * Converts import IR from {@link FountainParser} into typed chant
 * TypeScript: `import { Environment, ... } from
 * "@intentius/chant-lexicon-fountain";` plus one `export const` per
 * resource. `repositories` entries are wrapped in `new Repository({...})`
 * — the one nested property declarable on the fountain surface.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

type Nested = { kind: "single" | "array"; cls: string };

const NESTED_DECLARABLES: Record<string, Record<string, Nested>> = {
  Environment: {
    repositories: { kind: "array", cls: "Repository" },
  },
};

export class FountainGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const imports = new Set<string>();
    const bodyLines: string[] = [];

    for (const resource of ir.resources) {
      const parts = resource.type.split("::");
      const className = parts.length >= 3 ? parts[2] : resource.type;
      imports.add(className);
      const varName = camelCase(resource.logicalId);
      const props = formatProps(resource.properties, 0, className, imports);
      bodyLines.push(`export const ${varName} = new ${className}(${props});`);
      bodyLines.push("");
    }

    const lines: string[] = [];
    if (imports.size > 0) {
      lines.push(`import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-fountain";`);
      lines.push("");
    }
    lines.push(...bodyLines);

    return [{ path: "main.ts", content: lines.join("\n") + "\n" }];
  }
}

function camelCase(str: string): string {
  return str.replace(/[-_.](.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (_, c) => c.toLowerCase());
}

function formatProps(props: Record<string, unknown>, indent: number, ownerClass: string, imports: Set<string>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "{}";

  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const nested = NESTED_DECLARABLES[ownerClass];

  const lines = entries.map(([key, value]) => {
    const spec = nested?.[key];
    const rendered = spec !== undefined ? formatNested(value, indent + 1, spec, imports) : formatValue(value, indent + 1);
    return `${pad}${objectKey(key)}: ${rendered},`;
  });

  return `{\n${lines.join("\n")}\n${closePad}}`;
}

function formatNested(value: unknown, indent: number, spec: Nested, imports: Set<string>): string {
  const construct = (obj: unknown, at: number): string => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return formatValue(obj, at);
    imports.add(spec.cls);
    return `new ${spec.cls}(${formatProps(obj as Record<string, unknown>, at, spec.cls, imports)})`;
  };

  if (spec.kind === "single") return construct(value, indent);

  if (!Array.isArray(value) || value.length === 0) return "[]";
  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const items = value.map((v) => `${pad}${construct(v, indent + 1)},`);
  return `[\n${items.join("\n")}\n${closePad}]`;
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
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const lines = entries.map(([key, v]) => `${pad}${objectKey(key)}: ${formatValue(v, indent + 1)},`);
    return `{\n${lines.join("\n")}\n${closePad}}`;
  }

  return String(value);
}

function objectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}
