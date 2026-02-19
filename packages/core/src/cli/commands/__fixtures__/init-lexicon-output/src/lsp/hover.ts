import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconHover } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP hover information for fixture resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconHover().
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconHover(ctx, index, myCustomHoverFormatter);
  return undefined;
}
