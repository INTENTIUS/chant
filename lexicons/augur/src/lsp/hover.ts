/**
 * LSP hover for the augur lexicon (#2357).
 *
 * Two things are worth hovering, and they are the same two `./completions.ts`
 * offers: a `Profile` option key, and an entity type in the coverage table.
 *
 * The second is the useful one. An author looking at `"AWS::Logs::LogGroup"`
 * in a declaration wants to know whether a predicted cost will include it, and
 * the honest answer — "no, and here is why: it is priced by ingested volume,
 * which the declaration does not state" — is a sentence already written down in
 * `mapping.ts`. Reading it out here rather than transcribing it means the
 * editor cannot drift from the table.
 *
 * An entity type only reads as one when it is quoted, so an ordinary identifier
 * that happens to match is never mistaken for one.
 */

import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { coverageFor } from "../mapping";
import { PROFILE_KEYS } from "./completions";

/** The word under the cursor, widened to the quoted string it sits inside. */
export function quotedAt(lineText: string, word: string): string | undefined {
  if (!word) return undefined;
  for (const match of lineText.matchAll(/["']([^"']+)["']/g)) {
    if (match[1] === word || match[1].split(/[:.]/).includes(word)) return match[1];
  }
  return undefined;
}

function coverageHover(quoted: string): HoverInfo | undefined {
  const verdict = coverageFor(quoted);
  if (verdict.status === "unknown-type") return undefined;
  if (verdict.status === "mapped") {
    const { mapping } = verdict;
    const lines = [
      `**${quoted}**`,
      "",
      `augur sends this to the behaviour engine as a **${mapping.kind}** on **${mapping.provider}**.`,
      "",
      mapping.sizeProp
        ? `Size: read from \`${mapping.sizeProp}\`, verbatim and unparsed.`
        : "Size: none stated — this kind has no size to state.",
      "",
      mapping.regionProp
        ? `Region: \`${mapping.regionProp}\` when the declaration states one, otherwise the request's.`
        : "Region: the request's.",
    ];
    return { contents: lines.join("\n") };
  }
  if (verdict.status === "provider-not-modelled") {
    return {
      contents: [
        `**${quoted}**`,
        "",
        `**Not modelled.** This type belongs to ${verdict.substrate}, which the augur coverage`,
        "table does not cover. It is reported as `unsupported-kind` naming the substrate — a stated",
        "boundary rather than a gap, so there is nothing to file.",
      ].join("\n"),
    };
  }
  return {
    contents: [
      `**${quoted}**`,
      "",
      "**Declared unmapped.** augur does not send this to the engine, and reports it as",
      "`unsupported-kind` — never as a zero.",
      "",
      verdict.reason.charAt(0).toUpperCase() + verdict.reason.slice(1) + ".",
    ].join("\n"),
  };
}

function profileKeyHover(word: string): HoverInfo | undefined {
  const key = PROFILE_KEYS.find((k) => k.key === word);
  if (!key) return undefined;
  return { contents: `**${key.key}**\n\n${key.detail}` };
}

export function hover(ctx: HoverContext): HoverInfo | undefined {
  const word = ctx.word ?? "";
  if (!word) return undefined;
  const quoted = quotedAt(ctx.lineText ?? "", word);
  return (quoted ? coverageHover(quoted) : undefined) ?? profileKeyHover(word);
}
