import { resolve, dirname } from "path";
import { discover } from "../../../discovery/index";
import { buildOkfBundle, OKF_VERSION } from "../../../okf";
import { loadOkfBundle, bindConcepts, type OkfConcept } from "../../../okf-read";
import { loadChantConfigUpward, resolveKnowledgeDir } from "../../../config";

/** One bound concept as surfaced in an explain knowledge section — the trio the #1867 design calls for, not the full {@link OkfConcept}. */
export interface ExplainKnowledgeEntry {
  type: string;
  title?: string;
  path: string;
}

function toKnowledgeEntry(concept: OkfConcept): ExplainKnowledgeEntry {
  return { type: concept.type, title: concept.title, path: concept.path };
}

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
        enum: ["markdown", "json", "okf"],
        description: "Output format (default: markdown). okf: an OKF v0.2 knowledge bundle — one markdown concept per entity plus an index.md (#1058)",
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
  const format = (params.format as "markdown" | "json" | "okf") ?? "markdown";

  const infraPath = resolve(path);
  const result = await discover(infraPath);

  // OKF knowledge bundle (#1058): one concept document per entity plus a root
  // index.md, returned as bundle-relative path → content. The CLI path writes
  // the same files to a directory.
  if (format === "okf") {
    return {
      okf_version: OKF_VERSION,
      files: Object.fromEntries(buildOkfBundle(result, infraPath).map((f) => [f.path, f.content])),
      errors: result.errors.map((e) => e.message),
    };
  }

  // Authored knowledge (#1867, design #1059): bind the project's OKF bundle
  // (if any) to the discovered entities and carry each bound concept's
  // type/title/path into the summary. A project with no `knowledge/` yet
  // binds nothing — `bound` is empty — so the section is omitted below
  // rather than rendered empty; this is the CLI and MCP tool's one shared
  // code path, so both surfaces match by construction.
  // `loadChantConfigUpward` walks up from `infraPath` (chant #1117) — a
  // `chant explain src/<stack>` two levels below `chant.config.ts` must find
  // the same `knowledge/` a `chant explain .` at the root would, matching
  // `build.ts`'s `configDir` derivation for the same reason.
  const loaded = await loadChantConfigUpward(infraPath);
  const projectRoot = loaded.configPath ? dirname(loaded.configPath) : infraPath;
  const knowledgeDir = resolveKnowledgeDir(loaded.config, projectRoot);
  const bundle = await loadOkfBundle(knowledgeDir);
  const { bound } = bindConcepts(bundle, result.entities);
  const knowledge = new Map<string, ExplainKnowledgeEntry[]>(
    Array.from(bound.entries()).map(([name, concepts]) => [name, concepts.map(toKnowledgeEntry)]),
  );

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
    // Omitted entirely when no entity bound a concept — "cleanly absent" per
    // #1867's AC, not an empty `{}`.
    return knowledge.size > 0
      ? { ...summary, knowledge: Object.fromEntries(knowledge) }
      : summary;
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

  if (knowledge.size > 0) {
    lines.push("## Knowledge");
    lines.push("");
    for (const [name, entries] of knowledge) {
      lines.push(`### \`${name}\``);
      for (const entry of entries) {
        const title = entry.title ? `${entry.title} ` : "";
        lines.push(`- ${entry.type || "concept"}: ${title}(\`${entry.path}\`)`);
      }
      lines.push("");
    }
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
