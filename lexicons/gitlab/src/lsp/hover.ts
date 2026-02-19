import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-gitlab.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for GitLab CI entity types.
 */
export function gitlabHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`GitLab CI type: \`${entry.resourceType}\``);

  if (entry.kind === "resource") {
    lines.push("");
    lines.push("*Resource entity — serialized as a top-level CI key*");
  } else {
    lines.push("");
    lines.push("*Property entity — used as a nested value in resources*");
  }

  return { contents: lines.join("\n") };
}
