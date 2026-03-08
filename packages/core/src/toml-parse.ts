/**
 * TOML parser.
 *
 * Handles the TOML subset used by Chant lexicons: tables, arrays of tables,
 * key-value pairs, inline tables, inline arrays, strings, numbers, booleans.
 */

import { unescapeString, stripInlineComment } from "./toml-utils";

/**
 * Parse a TOML document string into a plain object.
 *
 * Uses a built-in parser that handles the TOML subset used by Flyway
 * configuration files.
 */
export function parseTOML(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentPath: string[] = [];
  let isArrayOfTables = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (line === "" || line.startsWith("#")) continue;

    // Array of tables: [[section.path]]
    const aotMatch = line.match(/^\[\[([^\]]+)\]\]\s*(?:#.*)?$/);
    if (aotMatch) {
      currentPath = parseDottedKey(aotMatch[1].trim());
      isArrayOfTables = true;
      // Ensure the array exists and add a new entry
      const arr = ensureArrayAt(result, currentPath);
      arr.push({});
      continue;
    }

    // Table header: [section.path]
    const tableMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (tableMatch) {
      currentPath = parseDottedKey(tableMatch[1].trim());
      isArrayOfTables = false;
      ensureTableAt(result, currentPath);
      continue;
    }

    // Key-value pair
    const kvResult = parseKeyValue(line);
    if (kvResult) {
      const target = isArrayOfTables
        ? getLastArrayEntry(result, currentPath)
        : getTableAt(result, currentPath);
      if (target) {
        setNestedValue(target, kvResult.key, kvResult.value);
      }
      continue;
    }
  }

  return result;
}

// ── Key-value parsing ─────────────────────────────────────────────

interface KeyValueResult {
  key: string[];
  value: unknown;
}

/**
 * Parse a key = value line.
 */
function parseKeyValue(line: string): KeyValueResult | null {
  // Find the = sign (not inside quotes)
  const eqIndex = findEquals(line);
  if (eqIndex === -1) return null;

  const rawKey = line.slice(0, eqIndex).trim();
  const rawValue = line.slice(eqIndex + 1).trim();

  const key = parseDottedKey(rawKey);
  const value = parseTOMLValue(rawValue);

  return { key, value };
}

/**
 * Find the index of the first `=` not inside quotes.
 */
function findEquals(line: string): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && (i === 0 || line[i - 1] !== "\\")) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === "=" && !inSingleQuote && !inDoubleQuote) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse a dotted key like `flyway.placeholders.name` into path segments.
 */
function parseDottedKey(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ".") {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ── Value parsing ─────────────────────────────────────────────────

/**
 * Parse a TOML value string.
 */
function parseTOMLValue(raw: string): unknown {
  // Strip inline comments (not inside strings)
  const value = stripInlineComment(raw);

  if (value === "true") return true;
  if (value === "false") return false;

  // String values
  if (value.startsWith('"""')) {
    const end = value.indexOf('"""', 3);
    return end !== -1 ? value.slice(3, end) : value.slice(3);
  }
  if (value.startsWith("'''")) {
    const end = value.indexOf("'''", 3);
    return end !== -1 ? value.slice(3, end) : value.slice(3);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return unescapeString(value.slice(1, -1));
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1); // Literal string, no escaping
  }

  // Array
  if (value.startsWith("[")) {
    return parseTOMLArray(value);
  }

  // Inline table
  if (value.startsWith("{")) {
    return parseTOMLInlineTable(value);
  }

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;

  // Bare string / date (return as string)
  return value;
}

/**
 * Parse a TOML inline array.
 */
function parseTOMLArray(raw: string): unknown[] {
  // Remove outer brackets
  const inner = raw.slice(1, raw.lastIndexOf("]")).trim();
  if (inner === "") return [];

  const items: unknown[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && inner[i - 1] !== "\\") {
        inString = false;
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed !== "") items.push(parseTOMLValue(trimmed));
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed !== "") items.push(parseTOMLValue(trimmed));

  return items;
}

/**
 * Parse a TOML inline table.
 */
function parseTOMLInlineTable(raw: string): Record<string, unknown> {
  const inner = raw.slice(1, raw.lastIndexOf("}")).trim();
  if (inner === "") return {};

  const result: Record<string, unknown> = {};
  let current = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && inner[i - 1] !== "\\") {
        inString = false;
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parseInlineTableEntry(current.trim(), result);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) parseInlineTableEntry(current.trim(), result);
  return result;
}

function parseInlineTableEntry(entry: string, target: Record<string, unknown>): void {
  const kv = parseKeyValue(entry);
  if (kv) {
    setNestedValue(target, kv.key, kv.value);
  }
}

// ── Object path helpers ───────────────────────────────────────────

function ensureTableAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = root;
  for (const segment of path) {
    if (!(segment in current)) {
      current[segment] = {};
    }
    const next = current[segment];
    if (Array.isArray(next)) {
      // Navigate into last array entry
      current = next[next.length - 1] as Record<string, unknown>;
    } else if (typeof next === "object" && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      const obj: Record<string, unknown> = {};
      current[segment] = obj;
      current = obj;
    }
  }
  return current;
}

function ensureArrayAt(root: Record<string, unknown>, path: string[]): unknown[] {
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (!(segment in current)) {
      current[segment] = {};
    }
    const next = current[segment];
    if (Array.isArray(next)) {
      current = next[next.length - 1] as Record<string, unknown>;
    } else if (typeof next === "object" && next !== null) {
      current = next as Record<string, unknown>;
    }
  }

  const lastKey = path[path.length - 1];
  if (!(lastKey in current) || !Array.isArray(current[lastKey])) {
    current[lastKey] = [];
  }
  return current[lastKey] as unknown[];
}

function getTableAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = root;
  for (const segment of path) {
    const next = current[segment];
    if (Array.isArray(next)) {
      current = next[next.length - 1] as Record<string, unknown>;
    } else if (typeof next === "object" && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      return current;
    }
  }
  return current;
}

function getLastArrayEntry(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = current[path[i]];
    if (Array.isArray(next)) {
      current = next[next.length - 1] as Record<string, unknown>;
    } else if (typeof next === "object" && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      return null;
    }
  }

  const lastKey = path[path.length - 1];
  const arr = current[lastKey];
  if (Array.isArray(arr) && arr.length > 0) {
    return arr[arr.length - 1] as Record<string, unknown>;
  }
  return null;
}

function setNestedValue(target: Record<string, unknown>, key: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < key.length - 1; i++) {
    if (!(key[i] in current)) {
      current[key[i]] = {};
    }
    current = current[key[i]] as Record<string, unknown>;
  }
  current[key[key.length - 1]] = value;
}
