import { build } from "../../../build";
import { resolve } from "path";

// Default lexicon serializer for MCP builds (fallback when no lexicon is detected)
const defaultLexicon = {
  name: "default",
  rulePrefix: "DF",
  serialize(entities: Map<string, unknown>): string {
    const output: Record<string, unknown> = {};
    for (const [name, entity] of entities) {
      output[name] = entity;
    }
    return JSON.stringify(output, null, 2);
  },
};

/**
 * Build tool definition for MCP
 */
export const buildTool = {
  name: "build",
  description: "Build chant infrastructure code and generate output for the target lexicon",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Path to the infrastructure directory or file to build",
      },
      output: {
        type: "string",
        description: "Output file path (optional, returns in response if not specified)",
      },
      format: {
        type: "string",
        enum: ["json", "yaml"],
        description: "Output format (default: json)",
      },
    },
    required: ["path"],
  },
};

/**
 * Handle build tool invocation
 */
export async function handleBuild(params: Record<string, unknown>): Promise<unknown> {
  const path = params.path as string;
  const format = (params.format as "json" | "yaml") ?? "json";

  const infraPath = resolve(path);
  const result = await build(infraPath, [defaultLexicon]);

  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  // Combine all lexicon outputs
  const combined: Record<string, unknown> = {};
  for (const [lexiconName, lexiconOutput] of result.outputs) {
    combined[lexiconName] = JSON.parse(lexiconOutput);
  }

  let output = JSON.stringify(combined, null, 2);
  if (format === "yaml") {
    // Basic YAML conversion
    output = jsonToYaml(JSON.parse(output));
  }

  return {
    success: true,
    resourceCount: result.entities.size,
    output,
    format,
  };
}

/**
 * Simple JSON to YAML converter
 */
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (obj === null) return "null";
  if (obj === undefined) return "~";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((item) => `${spaces}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const yamlValue = jsonToYaml(value, indent + 1);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return `${spaces}${key}:\n${yamlValue}`;
        }
        return `${spaces}${key}: ${yamlValue.trimStart()}`;
      })
      .join("\n");
  }

  return String(obj);
}
