/**
 * TOML emitter.
 *
 * Converts JavaScript objects to TOML document strings.
 * Handles scalars, tables, arrays, array of tables, and inline tables.
 */

import { escapeKey, sortKeys } from "./toml-utils";

export interface EmitTOMLOptions {
  /** Comment to prepend at the top of the document. */
  header?: string;
  /** Key ordering hint: keys matching earlier entries appear first. */
  keyOrder?: string[];
}

/**
 * Emit a JavaScript object as a TOML document string.
 *
 * - Top-level scalars, arrays of scalars → bare key-value pairs.
 * - Nested objects → `[section]` tables.
 * - Arrays of objects → `[[section]]` array of tables.
 * - Deeply nested objects → `[parent.child]` dotted sections.
 */
export function emitTOML(value: unknown, options?: EmitTOMLOptions): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("emitTOML expects a plain object at the top level");
  }

  const lines: string[] = [];

  if (options?.header) {
    for (const line of options.header.split("\n")) {
      lines.push(`# ${line}`);
    }
    lines.push("");
  }

  const obj = value as Record<string, unknown>;
  emitTable(obj, [], lines, options?.keyOrder);

  // Trim trailing blank lines, ensure single trailing newline
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n") + "\n";
}

/**
 * Emit a TOML table (recursively handles nested tables and array of tables).
 */
function emitTable(
  obj: Record<string, unknown>,
  path: string[],
  lines: string[],
  keyOrder?: string[],
): void {
  const keys = sortKeys(Object.keys(obj), keyOrder);

  // First pass: emit all scalar / inline values
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) continue;
    if (isTableValue(val)) continue; // handled in second pass
    if (isArrayOfTables(val)) continue; // handled in second pass

    lines.push(`${escapeKey(key)} = ${emitValue(val)}`);
  }

  // Second pass: emit nested tables
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) continue;

    if (isArrayOfTables(val)) {
      const arr = val as Record<string, unknown>[];
      for (const item of arr) {
        lines.push("");
        const sectionPath = [...path, key];
        lines.push(`[[${sectionPath.map(escapeKey).join(".")}]]`);
        emitTable(item, sectionPath, lines, keyOrder);
      }
    } else if (isTableValue(val)) {
      lines.push("");
      const sectionPath = [...path, key];
      lines.push(`[${sectionPath.map(escapeKey).join(".")}]`);
      emitTable(val as Record<string, unknown>, sectionPath, lines, keyOrder);
    }
  }
}

/**
 * Check if a value should be emitted as a `[table]` section.
 */
function isTableValue(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    !(val instanceof Date)
  );
}

/**
 * Check if a value is an array of tables (`[[section]]`).
 */
function isArrayOfTables(val: unknown): boolean {
  if (!Array.isArray(val) || val.length === 0) return false;
  return val.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item) && !(item instanceof Date),
  );
}

/**
 * Emit a TOML value (scalar, array of scalars, inline table).
 */
function emitValue(val: unknown): string {
  if (val === null || val === undefined) {
    return '""'; // TOML has no null — emit empty string
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (Number.isInteger(val)) return String(val);
    return String(val);
  }

  if (typeof val === "string") {
    return emitString(val);
  }

  if (val instanceof Date) {
    return val.toISOString();
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    // Array of scalars → inline array
    const items = val.map((item) => emitValue(item));
    const inline = `[${items.join(", ")}]`;
    if (inline.length <= 80) return inline;
    // Multi-line array for long content
    const multiLines = val.map((item) => `  ${emitValue(item)},`);
    return "[\n" + multiLines.join("\n") + "\n]";
  }

  // Inline table for non-table contexts (shouldn't normally reach here
  // because isTableValue is checked first, but handles edge cases)
  if (typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const pairs = entries.map(([k, v]) => `${escapeKey(k)} = ${emitValue(v)}`);
    return `{ ${pairs.join(", ")} }`;
  }

  return String(val);
}

/**
 * Emit a TOML string with proper quoting.
 */
function emitString(val: string): string {
  // Use basic strings with escaping for most values
  if (val.includes("\n") || val.includes("\r")) {
    // Multi-line basic string
    const escaped = val
      .replace(/\\/g, "\\\\")
      .replace(/"""/g, '\\"""');
    return `"""\n${escaped}"""`;
  }

  // Regular basic string
  const escaped = val
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}
