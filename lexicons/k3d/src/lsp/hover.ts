import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-k3d.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for k3d entity types.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`k3d type: \`${entry.resourceType}\``);
  lines.push("");
  if (entry.kind === "resource") {
    lines.push(
      "*Resource entity — serialized as a `k3d.io/v1alpha5` SimpleConfig " +
        "document that `k3d cluster create --config` consumes verbatim*",
    );
  } else {
    lines.push("*Property entity — a nested value in a Cluster declaration*");
  }

  return { contents: lines.join("\n") };
}
