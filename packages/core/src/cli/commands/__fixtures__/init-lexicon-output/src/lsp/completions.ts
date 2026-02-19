import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP completions for fixture resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconCompletions().
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconCompletions(ctx, index, "fixture resource");
  return [];
}
