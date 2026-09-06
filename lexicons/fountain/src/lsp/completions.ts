import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { fountainLexiconIndex } from "./lexicon-index";

/**
 * Provide LSP completions for fountain resources — class names after
 * `new `, property names inside a constructor.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, fountainLexiconIndex(), "fountain resource");
}
