/**
 * LSP hover for the terraform lexicon (#2088). See `./completions.ts`'s
 * module doc for why this reads `chant.config.*` as text rather than a
 * generated index, and completes/documents the same two things: a
 * `terraform.roots` name (when the word under the cursor is quoted next to
 * it, so an ordinary identifier never gets mistaken for a root) and one of
 * the composite/builder option keys (`./option-keys.ts`), the latter needing
 * no reachable config at all.
 */

import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { resolveRootsForUri } from "./context";
import { ALL_OPTION_KEYS } from "./option-keys";

/** `"app"` or `'app'` — the word is only a root reference if it sits inside a quote pair on the line. */
function isQuoted(lineText: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`["']${word}["']`).test(lineText);
}

function rootHover(uri: string, word: string, lineText: string): HoverInfo | undefined {
  if (!isQuoted(lineText, word)) return undefined;
  const roots = resolveRootsForUri(uri);
  const root = roots?.[word];
  if (!root) return undefined;

  const lines = [`**${word}**`, "", "terraform root (`terraform.roots." + word + "`)"];
  if (root.dir) lines.push("", `\`dir\`: \`${root.dir}\``);
  if (root.workspace) lines.push("", `\`workspace\`: \`${root.workspace}\``);
  if (root.varFiles?.length) lines.push("", `\`varFiles\`: ${root.varFiles.map((f) => `\`${f}\``).join(", ")}`);
  return { contents: lines.join("\n") };
}

function optionKeyHover(word: string): HoverInfo | undefined {
  const detail = ALL_OPTION_KEYS.get(word);
  if (!detail) return undefined;
  return { contents: `**${word}**\n\n${detail}` };
}

export function hover(ctx: HoverContext): HoverInfo | undefined {
  const word = ctx.word ?? "";
  if (!word) return undefined;
  return rootHover(ctx.uri, word, ctx.lineText ?? "") ?? optionKeyHover(word);
}
