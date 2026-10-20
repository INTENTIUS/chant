import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LEXICON_ENTRIES, TEMPLATE_PROPERTIES } from "../catalog";

/**
 * e2b hover: the `Template` class, with its properties and what it builds
 * into, and each of its properties by name.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  const { word } = ctx;
  if (!word) return undefined;

  const entry = LEXICON_ENTRIES[word];
  if (entry) {
    const lines = [
      `**${word}**`,
      "",
      `E2B type: \`${entry.resourceType}\``,
      "",
      "*A sandbox template, written out as `e2b.<name>.Dockerfile` and built with `e2b template create`.*",
      "",
      ...Object.entries(TEMPLATE_PROPERTIES).map(
        ([name, p]) => `- \`${name}${p.required ? "" : "?"}: ${p.type}\`: ${p.description}`,
      ),
    ];
    return { contents: lines.join("\n") };
  }

  // A property name only means a Template property on a line that builds one
  // or inside its object, so the hover stays quiet on an unrelated `name`.
  const prop = TEMPLATE_PROPERTIES[word];
  if (prop && /\bTemplate\b|^\s*\w+\??\s*:/.test(ctx.lineText ?? "") && ctx.content.includes("Template")) {
    return { contents: `**${word}**${prop.required ? "" : " (optional)"}: \`${prop.type}\`\n\n${prop.description}` };
  }
  return undefined;
}
