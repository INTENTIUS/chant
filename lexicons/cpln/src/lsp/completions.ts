import { createRequire } from "module";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

/**
 * The generated registry, loaded once. It carries every cpln resource and
 * property type with its constraints, which is exactly what the shared
 * completion provider indexes — so completions cannot drift from the types.
 */
function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-cpln.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * LSP completions for cpln resources — class names after `new `, property
 * names inside a constructor.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "cpln resource");
}
