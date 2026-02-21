import type { LexiconPlugin } from "../../../lexicon";

/**
 * Search tool definition for MCP
 */
export const searchTool = {
  name: "search",
  description: "Search the resource catalog across loaded lexicons by keyword",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query — matches against resource type, class name, and kind",
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
    const results: Array<CatalogEntry & { lexicon: string; score: number }> = [];

    const candidates = lexiconFilter
      ? plugins.filter((p) => p.name === lexiconFilter)
      : plugins;

    for (const plugin of candidates) {
      const resources = plugin.mcpResources?.() ?? [];
      const catalog = resources.find((r) => r.uri === "resource-catalog");
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

    // Sort: prefix matches first, then alphabetical by resourceType
    results.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return (a.resourceType ?? "").localeCompare(b.resourceType ?? "");
    });

    const limited = results.slice(0, limit);

    return {
      query,
      total: results.length,
      results: limited.map(({ score: _score, ...entry }) => entry),
    };
  };
}
