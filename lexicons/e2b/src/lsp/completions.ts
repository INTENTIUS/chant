import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { LEXICON_ENTRIES } from "../catalog";

const index = new LexiconIndex(LEXICON_ENTRIES);

/**
 * e2b completions: `Template` after `new`, and its properties inside the
 * object passed to it.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, index, "E2B sandbox template");
}
