import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

const require = createRequire(import.meta.url);
let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-slurm.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Slurm resource types.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  if (entry.kind !== "resource") return undefined;

  const lines: string[] = [];
  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Slurm resource type: \`${entry.resourceType}\``);

  if ("description" in entry && entry.description) {
    lines.push("");
    lines.push(String(entry.description));
  }

  return { markdown: lines.join("\n") };
}
