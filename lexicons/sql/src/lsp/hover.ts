import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { registryIndex } from "./registry";

/** Hover for the sql lexicon's entity classes, from the generated registry. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, registryIndex(), entityHover);
}

function entityHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const [dialect] = entry.resourceType.split("::");
  return { contents: `**${className}**\n\n${dialect} type: \`${entry.resourceType}\`` };
}
