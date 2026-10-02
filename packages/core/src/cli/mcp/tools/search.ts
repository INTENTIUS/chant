import type { LexiconPlugin } from "../../../lexicon";
import { collectComposites, compositeMatchScore } from "./composites";

/**
 * Search tool definition for MCP
 */
export const searchTool = {
  name: "search",
  description:
    "Search the resource catalog and the composite catalog across loaded lexicons by keyword; a composite comes back with kind 'composite'",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search query: matches a resource's type, class name and kind, and a composite's name, description and the resource kinds it bundles",
      },
      lexicon: {
        type: "string",
        description: "Filter results to a specific lexicon (e.g. 'aws', 'gitlab')",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 20)",
      },
    },
    required: ["query"],
  },
};

interface CatalogEntry {
  className: string;
  resourceType: string;
  kind?: string;
}

/** A composite in search results (#2662): `kind` is always `"composite"`. */
interface CompositeResult {
  kind: "composite";
  name: string;
  description: string;
  bundles: string[];
}

type SearchResult = (CatalogEntry | CompositeResult) & { lexicon: string; score: number };

function sortKey(result: SearchResult): string {
  return "resourceType" in result ? result.resourceType ?? "" : result.name;
}

/**
 * Create a search handler with access to loaded plugins
 */
export function createSearchHandler(
  plugins: LexiconPlugin[],
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params) => {
    const query = params.query as string;
    const lexiconFilter = params.lexicon as string | undefined;
    const limit = (params.limit as number) ?? 20;

    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];

    const candidates = lexiconFilter
      ? plugins.filter((p) => p.name === lexiconFilter)
      : plugins;

    for (const plugin of candidates) {
      const resources = plugin.mcpResources?.() ?? [];
      // Catalog URIs were unscoped ("resource-catalog") before lexicon
      // namespacing landed; new lexicons emit "<lexicon>:resource-catalog"
      // to avoid cross-lexicon collision. Support both.
      const catalog = resources.find(
        (r) => r.uri === "resource-catalog" || r.uri.endsWith(":resource-catalog"),
      );
      if (!catalog) continue;

      let entries: CatalogEntry[];
      try {
        const raw = await catalog.handler();
        entries = JSON.parse(raw);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fields = [
          entry.resourceType?.toLowerCase() ?? "",
          entry.className?.toLowerCase() ?? "",
          entry.kind?.toLowerCase() ?? "",
        ];

        const match = fields.some((f) => f.includes(lowerQuery));
        if (!match) continue;

        // Score: prefix match on resourceType or className ranks higher
        const isPrefix = fields.some((f) => f.startsWith(lowerQuery));
        const score = isPrefix ? 1 : 0;

        results.push({ ...entry, lexicon: plugin.name, score });
      }
    }

    // Composites (#2662), so one query finds both a resource type and the
    // composite that bundles it. A name or bundled-kind prefix ranks with the
    // resource prefix matches. The full entry (params included) is the
    // `composites` tool's answer; search keeps a result short.
    for (const entry of collectComposites(candidates)) {
      const score = compositeMatchScore(entry, lowerQuery);
      if (score === 0) continue;
      const isPrefix =
        entry.name.toLowerCase().startsWith(lowerQuery) ||
        entry.bundles.some((b) => b.toLowerCase().startsWith(lowerQuery));
      results.push({
        kind: "composite",
        name: entry.name,
        description: entry.description,
        bundles: entry.bundles,
        lexicon: entry.lexicon,
        score: isPrefix ? 1 : 0,
      });
    }

    // Sort: prefix matches first; within a tier composites ahead of resource
    // types, since a handful of composites would otherwise sort behind every
    // `AWS::...` type the same word prefixes; then alphabetical.
    results.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const aComposite = a.kind === "composite" ? 0 : 1;
      const bComposite = b.kind === "composite" ? 0 : 1;
      if (aComposite !== bComposite) return aComposite - bComposite;
      return sortKey(a).localeCompare(sortKey(b));
    });

    const limited = results.slice(0, limit);

    return {
      query,
      total: results.length,
      results: limited.map(({ score: _score, ...entry }) => entry),
    };
  };
}
