import { createRequire } from "module";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import {
  LexiconIndex,
  lexiconCompletions,
  type LexiconEntry,
} from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-k3s.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide k3s completions based on context — Server, Agent, Registries and
 * the registry property entities, from the generated registry.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  return lexiconCompletions(ctx, getIndex(), "k3s entity");
}
