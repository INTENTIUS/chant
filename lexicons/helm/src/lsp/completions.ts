import { createRequire } from "module";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-helm.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide Helm resource completions based on context.
 */
export function helmCompletions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "Helm chart resource");
}
