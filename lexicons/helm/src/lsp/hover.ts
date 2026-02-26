import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-helm.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for Helm resource types.
 */
export function helmHover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Helm type: \`${entry.resourceType}\``);

  if (entry.kind === "resource") {
    lines.push("");
    lines.push("*Resource — serialized as a top-level Helm chart artifact*");
  } else {
    lines.push("");
    lines.push("*Property — used as a nested value in Helm resources*");
  }

  if (entry.attrs && Object.keys(entry.attrs).length > 0) {
    lines.push("");
    lines.push("**Attributes:**");
    for (const [key, value] of Object.entries(entry.attrs)) {
      lines.push(`- \`${key}\` \u2192 \`${value}\``);
    }
  }

  return { contents: lines.join("\n") };
}
