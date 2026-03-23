import { createRequire } from "module";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

const require = createRequire(import.meta.url);
let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-slurm.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide LSP completions for Slurm resources.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "Slurm resource");
}
