import type { CompositeEntry, LexiconPlugin } from "../../../lexicon";

/**
 * The `composites` tool (#2662): what composites the loaded lexicons export,
 * what each one bundles and what it takes. "What composites do you have for
 * aws?" is `{ lexicon: "aws" }`.
 *
 * Everything here reads `LexiconPlugin.composites()`, which is static catalog
 * data. No composite is loaded or called and no provider is asked anything.
 */
export const compositesTool = {
  name: "composites",
  description:
    "List the composites the loaded lexicons export: what each builds, the resource kinds it bundles, and its parameters",
  inputSchema: {
    type: "object" as const,
    properties: {
      lexicon: {
        type: "string",
        description: "Only composites from this lexicon (e.g. 'aws', 'k8s')",
      },
      query: {
        type: "string",
        description: "Keyword matched against the composite's name, description, bundled resource kinds and parameter names",
      },
      limit: {
        type: "number",
        description: "Maximum number of composites to return (default: 50)",
      },
    },
  },
};

/**
 * Every composite the plugins contribute, in plugin order. A plugin whose
 * `composites()` throws contributes nothing rather than failing the listing.
 */
export function collectComposites(plugins: LexiconPlugin[]): CompositeEntry[] {
  const entries: CompositeEntry[] = [];
  for (const plugin of plugins) {
    let contributed: CompositeEntry[] = [];
    try {
      contributed = plugin.composites?.() ?? [];
    } catch {
      contributed = [];
    }
    for (const entry of contributed) entries.push({ ...entry, lexicon: entry.lexicon || plugin.name });
  }
  return entries;
}

/**
 * How well an entry matches a lowercased keyword: 0 for no match, higher for
 * better. A name match beats a bundled kind, which beats a word in the
 * description or a parameter name, so `queue` lists `LambdaSqs` ahead of a
 * composite that merely mentions queues.
 */
export function compositeMatchScore(entry: CompositeEntry, lowerQuery: string): number {
  const name = entry.name.toLowerCase();
  if (name.startsWith(lowerQuery)) return 4;
  if (name.includes(lowerQuery)) return 3;
  if (entry.bundles.some((b) => b.toLowerCase().includes(lowerQuery))) return 2;
  if (entry.description.toLowerCase().includes(lowerQuery)) return 1;
  if (entry.params.some((p) => p.name.toLowerCase().includes(lowerQuery))) return 1;
  return 0;
}

export function createCompositesHandler(
  plugins: LexiconPlugin[],
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params) => {
    const lexicon = typeof params.lexicon === "string" && params.lexicon !== "" ? params.lexicon : undefined;
    const query = typeof params.query === "string" && params.query !== "" ? params.query : undefined;
    const limit = typeof params.limit === "number" ? params.limit : 50;

    let entries = collectComposites(plugins);
    if (lexicon) entries = entries.filter((e) => e.lexicon === lexicon);

    if (query) {
      const lowerQuery = query.toLowerCase();
      entries = entries
        .map((entry) => ({ entry, score: compositeMatchScore(entry, lowerQuery) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
        .map(({ entry }) => entry);
    }

    return {
      ...(lexicon ? { lexicon } : {}),
      ...(query ? { query } : {}),
      // The loaded lexicons, so an empty answer for `lexicon: "cedar"` reads
      // as "cedar exports none" when cedar is listed, and "not loaded" when not.
      lexicons: plugins.map((p) => p.name),
      total: entries.length,
      composites: entries.slice(0, limit),
    };
  };
}
