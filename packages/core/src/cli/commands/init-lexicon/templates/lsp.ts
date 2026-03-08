/**
 * LSP template generators for init-lexicon scaffold.
 */

export function generateLspCompletionsTs(name: string): string {
  return `import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP completions for ${name} resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconCompletions().
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconCompletions(ctx, index, "${name} resource");
  return [];
}
`;
}

export function generateLspHoverTs(name: string): string {
  return `import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconHover } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP hover information for ${name} resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconHover().
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconHover(ctx, index, myCustomHoverFormatter);
  return undefined;
}
`;
}
