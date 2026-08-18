import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { CATALOG } from "../catalog";
const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-render.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Provide hover information for render entity types.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Render type: \`${entry.resourceType}\``);
  lines.push("");
  const cat = CATALOG[entry.resourceType];
  if (entry.kind === "resource" && cat) {
    lines.push(`*Resource — created with \`POST ${cat.collection}\` on the Render Public API and reconciled by name*`);
    if (cat.marked) {
      lines.push("");
      lines.push("Carries chant's `CHANT_MANAGED_BY` env-var ownership marker; eligible for owned-only prune.");
    } else if (cat.boundary === "service") {
      lines.push("");
      lines.push("Inherits its parent service's ownership verdict (service boundary); pruned when the service is chant-owned and this is undeclared.");
    } else {
      lines.push("");
      lines.push("No ownership marker channel: verdict is `unknown`; never auto-pruned.");
    }
  } else if (entry.kind === "resource") {
    lines.push("*Resource — a Render Public API object*");
  } else {
    lines.push("*Property — a nested value in a Render resource declaration*");
  }

  return { contents: lines.join("\n") };
}
