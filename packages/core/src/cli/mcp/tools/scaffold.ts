import type { LexiconPlugin } from "../../../lexicon";

/**
 * Scaffold tool definition for MCP
 */
export const scaffoldTool = {
  name: "scaffold",
  description: "Generate starter code for a common infrastructure pattern",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Infrastructure pattern to scaffold (e.g. 's3-bucket', 'lambda', 'pipeline')",
      },
      lexicon: {
        type: "string",
        description: "Lexicon to use for scaffolding (e.g. 'aws', 'gitlab'). Auto-detected if omitted.",
      },
    },
    required: ["pattern"],
  },
};

/**
 * Create a scaffold handler with access to loaded plugins
 */
export function createScaffoldHandler(
  plugins: LexiconPlugin[],
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params) => {
    const pattern = params.pattern as string;
    const lexiconName = params.lexicon as string | undefined;

    // Try to find a matching plugin
    const candidates = lexiconName
      ? plugins.filter((p) => p.name === lexiconName)
      : plugins;

    // Search plugin init templates for a pattern match
    for (const plugin of candidates) {
      const templates = plugin.initTemplates?.();
      if (!templates) continue;

      // Match template filenames against the pattern (case-insensitive substring)
      const lowerPattern = pattern.toLowerCase();
      const matched: Array<{ filename: string; content: string }> = [];

      for (const [filename, content] of Object.entries(templates)) {
        if (filename.toLowerCase().includes(lowerPattern)) {
          matched.push({ filename, content });
        }
      }

      if (matched.length > 0) {
        return {
          lexicon: plugin.name,
          pattern,
          files: matched,
        };
      }
    }

    // Fall back to a generic skeleton
    const configContent = `/**
 * Shared configuration for ${pattern}
 */

// TODO: Import resource types from your lexicon
// import { ... } from "@intentius/chant-lexicon-<name>";

export const config = {
  // Add shared configuration here
};
`;

    const resourceContent = `/**
 * ${pattern} resource definition
 */

// TODO: Import resource types from your lexicon
// import { ... } from "@intentius/chant-lexicon-<name>";
// import { config } from "./config";

// export const ${toCamelCase(pattern)} = new ResourceType({
//   // Add properties here
// });
`;

    return {
      lexicon: lexiconName ?? null,
      pattern,
      files: [
        { filename: "config.ts", content: configContent },
        { filename: `${pattern}.ts`, content: resourceContent },
      ],
      note: "No lexicon-specific template found. Generic skeleton provided — fill in imports and resource types.",
    };
  };
}

function toCamelCase(s: string): string {
  return s
    .split(/[-_]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}
