/**
 * Lightweight YAML emitter and parser.
 *
 * Covers the subset of YAML used by Chant lexicons (scalars, block arrays,
 * nested objects, tagged values). Not a full YAML implementation — use a
 * dedicated library if you need anchors, multi-document streams, or
 * block scalars.
 */

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Emit a YAML value with proper indentation.
 *
 * - Primitives render inline.
 * - Arrays and objects render as block YAML, returning a string that starts
 *   with `\n` so the caller can append it after a key.
 * - Tagged values `{ tag, value }` emit `!tag [...]` or `!tag scalar`.
 */
export function emitYAML(value: unknown, indent: number): string {
  const prefix = "  ".repeat(indent);

  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    // Quote strings that could be misinterpreted
    if (
      value === "" ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      value === "yes" ||
      value === "no" ||
      value.includes(": ") ||
      value.includes("#") ||
      value.startsWith("*") ||
      value.startsWith("&") ||
      value.startsWith("!") ||
      value.startsWith("{") ||
      value.startsWith("[") ||
      value.startsWith("'") ||
      value.startsWith('"') ||
      value.startsWith("$") ||
      /^\d/.test(value)
    ) {
      // Use single quotes, escaping internal single quotes
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Object items in arrays
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          const firstEmitted = emitYAML(firstVal, indent + 2);
          if (firstEmitted.startsWith("\n")) {
            lines.push(`${prefix}- ${firstKey}:${firstEmitted}`);
          } else {
            lines.push(`${prefix}- ${firstKey}: ${firstEmitted}`);
          }
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            const emitted = emitYAML(val, indent + 2);
            if (emitted.startsWith("\n")) {
              lines.push(`${prefix}  ${key}:${emitted}`);
            } else {
              lines.push(`${prefix}  ${key}: ${emitted}`);
            }
          }
        }
      } else {
        lines.push(`${prefix}- ${emitYAML(item, indent + 1).trimStart()}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Handle tagged values (e.g. { tag: "!reference", value: [...] })
    if ("tag" in obj && "value" in obj && typeof obj.tag === "string") {
      if (Array.isArray(obj.value)) {
        return `${obj.tag} [${(obj.value as unknown[]).map(String).join(", ")}]`;
      }
      return `${obj.tag} ${emitYAML(obj.value, indent)}`;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const emitted = emitYAML(val, indent + 1);
      if (emitted.startsWith("\n")) {
        lines.push(`${prefix}${key}:${emitted}`);
      } else {
        lines.push(`${prefix}${key}: ${emitted}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Result of parsing a YAML block. */
export interface ParseResult {
  value: unknown;
  endIndex: number;
}

/**
 * Parse a YAML document (or JSON document) into a plain object.
 *
 * Tries `JSON.parse` first; falls back to a line-based YAML parser that
 * handles the subset of YAML commonly found in CI configuration files.
 */
export function parseYAML(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }

  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return parseYAMLLines(lines, 0, 0).value as Record<string, unknown>;
}

/**
 * Parse indentation-based YAML lines into a key-value object.
 */
export function parseYAMLLines(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break; // Dedented — done with this block
    if (indent > baseIndent && startIndex > 0) break; // Unexpected indent

    const keyMatch = line.match(/^(\s*)([^\s:][^:]*?):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[2].trim();
      const inlineValue = keyMatch[3].trim();

      if (inlineValue === "" || inlineValue.startsWith("#")) {
        // Check next line for array or nested object
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextIndent = nextLine.search(/\S/);
          if (nextIndent > indent && nextLine.trimStart().startsWith("- ")) {
            const arr = parseYAMLArray(lines, i + 1, nextIndent);
            result[key] = arr.value;
            i = arr.endIndex;
            continue;
          } else if (nextIndent > indent) {
            const nested = parseYAMLLines(lines, i + 1, nextIndent);
            result[key] = nested.value;
            i = nested.endIndex;
            continue;
          }
        }
        result[key] = null;
        i++;
      } else if (inlineValue.startsWith("[")) {
        // Inline array
        try {
          result[key] = JSON.parse(inlineValue);
        } catch {
          result[key] = inlineValue;
        }
        i++;
      } else if (inlineValue.startsWith("{")) {
        // Inline object
        try {
          result[key] = JSON.parse(inlineValue);
        } catch {
          result[key] = inlineValue;
        }
        i++;
      } else {
        result[key] = parseScalar(inlineValue);
        i++;
      }
    } else if (line.trimStart().startsWith("- ")) {
      break;
    } else {
      i++;
    }
  }

  return { value: result, endIndex: i };
}

/**
 * Parse a block array (lines starting with `- `).
 */
export function parseYAMLArray(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseResult {
  const result: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;

    const itemMatch = line.match(/^(\s*)- (.*)$/);
    if (itemMatch && indent === baseIndent) {
      const itemValue = itemMatch[2].trim();
      // Check if it's a key-value pair (object item in array)
      const kvMatch = itemValue.match(/^([^\s:][^:]*?):\s*(.*)$/);
      if (kvMatch) {
        const obj: Record<string, unknown> = {};
        obj[kvMatch[1].trim()] = parseScalar(kvMatch[2].trim());
        // Check for more keys at indent+2
        const nextIndent = indent + 2;
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) {
            j++;
            continue;
          }
          const ni = nextLine.search(/\S/);
          if (ni !== nextIndent) break;
          const nextKV = nextLine.match(/^(\s*)([^\s:][^:]*?):\s*(.*)$/);
          if (nextKV) {
            obj[nextKV[2].trim()] = parseScalar(nextKV[3].trim());
            j++;
          } else {
            break;
          }
        }
        result.push(obj);
        i = j;
      } else {
        result.push(parseScalar(itemValue));
        i++;
      }
    } else {
      break;
    }
  }

  return { value: result, endIndex: i };
}

/**
 * Coerce a scalar string to a typed value.
 */
export function parseScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  // Strip quotes
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return value;
}
