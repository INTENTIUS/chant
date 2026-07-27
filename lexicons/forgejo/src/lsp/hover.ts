/**
 * Forgejo LSP hover — delegated to github, not duplicated.
 *
 * Same reasoning as ./completions.ts: forgejo authors against github's
 * exact classes, so hover information for them is github's hover
 * information, unmodified.
 */

import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { githubPlugin } from "@intentius/chant-lexicon-github";

export function forgejoHover(ctx: HoverContext): HoverInfo | undefined {
  return githubPlugin.hoverProvider?.(ctx);
}
