import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { BUILTIN_CATALOG, lexiconRegistry } from "../catalog";
import { GRAFANA_SCHEMA_PIN } from "../pin";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/** Hover for grafana entity classes: what it declares and, for panels and queries, the Grafana plugin id. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), resourceHover);
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const cat = BUILTIN_CATALOG.find((c) => c.className === className);
  const lines = [`**${className}**`, "", `grafana type: \`${entry.resourceType}\``];
  if (cat?.description) lines.push("", cat.description);
  if (cat?.kind === "panel") {
    lines.push("", `Panel plugin \`${cat.pluginId}\`. Options typed from ${GRAFANA_SCHEMA_PIN.source} ${GRAFANA_SCHEMA_PIN.ref}.`);
  } else if (cat?.kind === "query") {
    lines.push("", `For \`${cat.pluginId}\` datasources. Typed from ${GRAFANA_SCHEMA_PIN.source} ${GRAFANA_SCHEMA_PIN.ref}.`);
  }
  return { contents: lines.join("\n") };
}
