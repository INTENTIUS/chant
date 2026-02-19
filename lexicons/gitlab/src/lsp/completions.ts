import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-gitlab.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide GitLab CI completions based on context.
 */
export function gitlabCompletions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "GitLab CI entity");
}
