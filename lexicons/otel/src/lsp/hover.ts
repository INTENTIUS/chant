import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { BUILTIN_CATALOG, lexiconRegistry } from "../catalog";
import { COLLECTOR_PIN } from "../define";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/** Hover for otel entity classes: what the component does and its collector id. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const cat = BUILTIN_CATALOG.find((c) => c.className === className);
  const lines = [`**${className}**`, "", `otel type: \`${entry.resourceType}\``];
  if (cat?.description) lines.push("", cat.description);
  if (cat?.type) {
    lines.push(
      "",
      `Collector id \`${cat.type}\`, or \`${cat.type}/<name>\` with \`name\` set. ` +
        `Config typed against ${COLLECTOR_PIN.source} ${COLLECTOR_PIN.version}.`,
    );
  }
  return { contents: lines.join("\n") };
}
