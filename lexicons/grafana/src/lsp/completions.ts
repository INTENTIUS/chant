import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { lexiconRegistry } from "../catalog";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/** Completions for the grafana entity classes: dashboards, datasources, panels, queries and variables. */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "Grafana entity");
}
