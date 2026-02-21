/**
 * GitLab CI YAML parser for `chant import`.
 *
 * Parses an existing .gitlab-ci.yml file into the core TemplateIR format,
 * mapping GitLab CI constructs to resources and property types.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

/**
 * Reserved top-level keys in .gitlab-ci.yml that are NOT job definitions.
 */
/**
 * Convert snake_case to camelCase — used only for TS variable names (logicalId),
 * NOT for spec property names.
 */
function snakeToCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const RESERVED_KEYS = new Set([
  "stages",
  "variables",
  "default",
  "workflow",
  "include",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages",
]);


/**
 * Parse a YAML document into a plain object.
 * Uses a simple YAML parser approach — GitLab CI YAML is straightforward
 * enough that we can parse it without a full YAML library by parsing JSON
 * or using Bun's built-in YAML support if available.
 */
function parseYAML(content: string): Record<string, unknown> {
  // Try JSON first (some CI files may be JSON)
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }

  // Simple YAML parser for GitLab CI files
  // This handles the common cases: scalars, arrays, objects, block scalars
  const lines = content.split("\n");
  return parseYAMLLines(lines, 0, 0).value as Record<string, unknown>;
}

interface ParseResult {
  value: unknown;
  endIndex: number;
}

function parseYAMLLines(lines: string[], startIndex: number, baseIndent: number): ParseResult {
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
            // Array
            const arr = parseYAMLArray(lines, i + 1, nextIndent);
            result[key] = arr.value;
            i = arr.endIndex;
            continue;
          } else if (nextIndent > indent) {
            // Nested object
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
      // We hit an array at the top level — shouldn't happen normally
      break;
    } else {
      i++;
    }
  }

  return { value: result, endIndex: i };
}

function parseYAMLArray(lines: string[], startIndex: number, baseIndent: number): ParseResult {
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

function parseScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  // Strip quotes
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return value;
}

/**
 * GitLab CI YAML parser implementation.
 */
export class GitLabParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const doc = parseYAML(content);
    const resources: ResourceIR[] = [];

    // Extract default
    if (doc.default && typeof doc.default === "object") {
      resources.push({
        logicalId: "defaults",
        type: "GitLab::CI::Default",
        properties: doc.default as Record<string, unknown>,
      });
    }

    // Extract workflow
    if (doc.workflow && typeof doc.workflow === "object") {
      resources.push({
        logicalId: "workflow",
        type: "GitLab::CI::Workflow",
        properties: doc.workflow as Record<string, unknown>,
      });
    }

    // Extract jobs — any top-level key not in RESERVED_KEYS
    for (const [key, value] of Object.entries(doc)) {
      if (RESERVED_KEYS.has(key)) continue;
      if (typeof value !== "object" || value === null) continue;

      // Check if it looks like a job (has script, stage, trigger, extends, etc.)
      const obj = value as Record<string, unknown>;
      if (
        obj.script !== undefined ||
        obj.stage !== undefined ||
        obj.trigger !== undefined ||
        obj.extends !== undefined ||
        obj.rules !== undefined ||
        obj.needs !== undefined
      ) {
        resources.push({
          logicalId: snakeToCamelCase(key.replace(/-/g, "_")),
          type: "GitLab::CI::Job",
          properties: obj as Record<string, unknown>,
          metadata: {
            originalName: key,
            stage: typeof obj.stage === "string" ? obj.stage : undefined,
          },
        });
      }
    }

    // Record include references as metadata
    const metadata: Record<string, unknown> = {};
    if (doc.stages) metadata.stages = doc.stages;
    if (doc.include) metadata.include = doc.include;
    if (doc.variables) metadata.variables = doc.variables;

    return {
      resources,
      parameters: [], // GitLab CI doesn't have parameters like CFN
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}
