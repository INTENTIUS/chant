/**
 * Generic TypeScript declaration (.d.ts) generation utilities.
 *
 * Provides functions for writing resource classes, property classes,
 * constructors, and enum types. Lexicon-specific generators use these
 * building blocks with their own orchestration logic.
 */

// ── Minimal input interfaces ────────────────────────────────────────

export interface DtsProperty {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface DtsAttribute {
  name: string;
  type: string;
}

export interface DtsPropertyType {
  name: string;
  properties: DtsProperty[];
}

export interface DtsResource {
  typeName: string;
  properties: DtsProperty[];
  attributes: DtsAttribute[];
}

// ── Writers ─────────────────────────────────────────────────────────

/**
 * Write a resource class declaration with constructor and readonly attributes.
 */
export function writeResourceClass(
  lines: string[],
  tsName: string,
  properties: DtsProperty[],
  attributes: DtsAttribute[],
  remap?: Map<string, string>,
): void {
  lines.push("");
  lines.push(`export declare class ${tsName} {`);
  writeConstructor(lines, properties, remap);

  // Attributes as readonly properties (sorted)
  const attrs = [...attributes].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of attrs) {
    const attrType = resolveConstructorType(a.type, remap);
    lines.push(`  readonly ${a.name}: ${attrType};`);
  }

  lines.push("}");
}

/**
 * Write a property class declaration with constructor.
 */
export function writePropertyClass(
  lines: string[],
  tsName: string,
  properties: DtsProperty[],
  remap?: Map<string, string>,
): void {
  lines.push("");
  lines.push(`export declare class ${tsName} {`);
  writeConstructor(lines, properties, remap);
  lines.push("}");
}

/**
 * Write a constructor with typed props parameter.
 */
export function writeConstructor(
  lines: string[],
  props: DtsProperty[],
  remap: Map<string, string> | undefined,
): void {
  if (props.length === 0) {
    lines.push("  constructor(props: Record<string, unknown>);");
    return;
  }

  // Sort: required first, then optional, each group alphabetically
  const sorted = [...props].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  lines.push("  constructor(props: {");
  for (const p of sorted) {
    const optional = p.required ? "" : "?";
    const tsType = resolveConstructorType(p.type, remap);
    if (p.description) {
      lines.push(`    /** ${p.description} */`);
    }
    lines.push(`    ${p.name}${optional}: ${tsType};`);
  }
  lines.push("  });");
}

/**
 * Write an enum union type.
 */
export function writeEnumType(lines: string[], tsName: string, values: string[]): void {
  const sorted = [...values].sort();
  const quoted = sorted.map((v) => JSON.stringify(v));

  const singleLine = `\nexport type ${tsName} = ${quoted.join(" | ")};`;
  if (singleLine.length <= 100) {
    lines.push(singleLine);
  } else {
    lines.push("");
    lines.push(`export type ${tsName} =`);
    for (let i = 0; i < quoted.length; i++) {
      const suffix = i < quoted.length - 1 ? "" : ";";
      lines.push(`  | ${quoted[i]}${suffix}`);
    }
  }
}

/**
 * Resolve a type string through the remap table, handling arrays and
 * common type normalization.
 */
export function resolveConstructorType(tsType: string, remap: Map<string, string> | undefined): string {
  // Handle array types
  if (tsType.endsWith("[]")) {
    const inner = tsType.slice(0, -2);
    return resolveConstructorType(inner, remap) + "[]";
  }

  // Primitive and pass-through types
  switch (tsType) {
    case "string":
    case "number":
    case "boolean":
    case "any":
      return tsType;
    case "Record<string, any>":
      return "Record<string, unknown>";
    case "Record<string, unknown>":
      return tsType;
  }

  // Remap parser property type names to resolved names
  if (remap) {
    const resolved = remap.get(tsType);
    if (resolved) return resolved;
  }

  return tsType;
}
