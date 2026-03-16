import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-github.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for GitHub Actions entity types.
 */
export function githubHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`GitHub Actions type: \`${entry.resourceType}\``);

  if (entry.kind === "resource") {
    lines.push("");
    lines.push("*Resource entity — serialized as a top-level workflow/job entry*");
  } else {
    lines.push("");
    lines.push("*Property entity — used as a nested value in resources*");
  }

  return { contents: lines.join("\n") };
}
