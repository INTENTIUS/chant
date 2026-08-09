import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import {
  LexiconIndex,
  lexiconHover,
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
 * Provide hover information for k3s entity types.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`k3s type: \`${entry.resourceType}\``);
  lines.push("");
  if (entry.kind === "resource") {
    lines.push(
      "*Resource entity — serialized as a file k3s consumes verbatim: " +
        "config.yaml for Server/Agent, registries.yaml for Registries*",
    );
  } else {
    lines.push("*Property entity — a nested value in a Registries declaration*");
  }

  return { contents: lines.join("\n") };
}
