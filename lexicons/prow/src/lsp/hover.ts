import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(moduleSourceUrl(import.meta.url));

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-prow.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for prow entity types.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`prow type: \`${entry.resourceType}\``);
  lines.push("");
  if (entry.kind === "resource") {
    lines.push("*A job, or the job config file: `chant build` writes it into the job config Prow loads*");
  } else {
    lines.push("*Property entity: a value nested in a job*");
  }

  return { contents: lines.join("\n") };
}
