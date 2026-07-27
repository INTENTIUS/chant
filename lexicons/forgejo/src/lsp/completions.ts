/**
 * Forgejo LSP completions — delegated to github, not duplicated.
 *
 * Forgejo reuses github's entire authoring surface (entities, composites) —
 * there is no forgejo-specific resource catalog to index. This forwards
 * straight to `githubPlugin`'s own completion provider, which already reads
 * github's generated entity catalog; forking a second copy of it here would
 * only drift the moment github's catalog regenerates.
 */

import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { githubPlugin } from "@intentius/chant-lexicon-github";

export function forgejoCompletions(ctx: CompletionContext): CompletionItem[] {
  return githubPlugin.completionProvider?.(ctx) ?? [];
}
