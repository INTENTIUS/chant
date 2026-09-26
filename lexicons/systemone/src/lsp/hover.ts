/**
 * LSP hover for the systemone lexicon: the `decide` step's option keys and the
 * `systemone` config keys (see `./keys.ts`).
 */

import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { ALL_KEYS } from "./keys";

export function hover(ctx: HoverContext): HoverInfo | undefined {
  const word = ctx.word ?? "";
  if (word === "decide") {
    return { contents: "**decide**(point, opts)\n\nAsk a decision point (ws-058) and record the answer. The backend its model decider names is called over the POST /v1/systemone wire format; the chain, threshold and escalation are core's." };
  }
  const detail = ALL_KEYS.get(word);
  return detail ? { contents: `**${word}**\n\n${detail}` } : undefined;
}
