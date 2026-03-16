import { resolve } from "path";
import { discover } from "../../../discovery/index";

/**
 * Explain tool definition for MCP
 */
export const explainTool = {
  name: "explain",
  description: "Analyze a chant project directory and return a structured summary of all discovered entities",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Path to the infrastructure directory to analyze",
      },
      format: {
        type: "string",
        enum: ["markdown", "json"],
        description: "Output format (default: markdown)",
      },
    },
    required: ["path"],
  },
};

/**
 * Handle explain tool invocation
 */
export async function handleExplain(params: Record<string, unknown>): Promise<unknown> {
  const path = params.path as string;
  const format = (params.format as "markdown" | "json") ?? "markdown";

  const infraPath = resolve(path);
  const result = await discover(infraPath);

  // Group entities by lexicon and kind
  const byLexicon = new Map<string, { resources: string[]; properties: string[] }>();

  for (const [name, entity] of result.entities) {
    const lexicon = entity.lexicon ?? "unknown";
    if (!byLexicon.has(lexicon)) {
      byLexicon.set(lexicon, { resources: [], properties: [] });
    }
    const group = byLexicon.get(lexicon)!;
    if (entity.kind === "property") {
      group.properties.push(name);
    } else {
      group.resources.push(name);
    }
  }

  // Collect dependency info
  const crossResourceDeps: Array<{ from: string; to: string }> = [];
  for (const [from, deps] of result.dependencies) {
    for (const to of deps) {
      crossResourceDeps.push({ from, to });
    }
  }

  const summary = {
    sourceFiles: result.sourceFiles,
    totalEntities: result.entities.size,
    lexicons: Object.fromEntries(
      Array.from(byLexicon.entries()).map(([lexicon, group]) => [
        lexicon,
        {
          resourceCount: group.resources.length,
          propertyCount: group.properties.length,
          resources: group.resources,
          properties: group.properties,
        },
      ]),
    ),
    dependencies: crossResourceDeps,
    errors: result.errors.map((e) => e.message),
  };

  if (format === "json") {
    return summary;
  }

  // Markdown format
  const lines: string[] = [];
  lines.push(`# Project Summary`);
  lines.push("");
  lines.push(`- **Source files:** ${result.sourceFiles.length}`);
  lines.push(`- **Total entities:** ${result.entities.size}`);
  lines.push("");

  for (const [lexicon, group] of byLexicon) {
    lines.push(`## Lexicon: ${lexicon}`);
    lines.push("");
    lines.push(`- Resources: ${group.resources.length}`);
    lines.push(`- Properties: ${group.properties.length}`);
    lines.push("");

    if (group.resources.length > 0) {
      lines.push("### Resources");
      for (const name of group.resources) {
        lines.push(`- \`${name}\``);
      }
      lines.push("");
    }

    if (group.properties.length > 0) {
      lines.push("### Properties");
      for (const name of group.properties) {
        lines.push(`- \`${name}\``);
      }
      lines.push("");
    }
  }

  if (crossResourceDeps.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    for (const dep of crossResourceDeps) {
      lines.push(`- \`${dep.from}\` → \`${dep.to}\``);
    }
    lines.push("");
  }

  if (result.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of result.errors) {
      lines.push(`- ${err.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
