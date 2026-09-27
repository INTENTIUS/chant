import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { CATALOG, lexiconRegistry } from "../catalog";
import { PROMETHEUS_PIN } from "../pin";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/** Hover for prometheus entity classes: what the entity is and which file it lands in. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const cat = CATALOG.find((c) => c.className === className);
  const lines = [`**${className}**`, "", `prometheus type: \`${entry.resourceType}\``];
  if (cat) {
    const pin = cat.file === "rule file" ? PROMETHEUS_PIN.prometheus : PROMETHEUS_PIN.alertmanager;
    lines.push("", cat.description, "", `Serializes into the ${cat.file}. Typed against ${pin.source} ${pin.version}.`);
  }
  return { contents: lines.join("\n") };
}
