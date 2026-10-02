import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { registryIndex } from "./registry";

/** Completions for the sql lexicon's entity classes, from the generated registry. */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, registryIndex(), "sql entity");
}
