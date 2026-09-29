import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { BUILTIN_CATALOG, lexiconRegistry } from "../catalog";
import { GRAFANA_SCHEMA_PIN } from "../pin";
import { panelDefinitionFor } from "../panels";

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
    const schema = cat.pluginId ? panelDefinitionFor(cat.pluginId)?.schema : undefined;
    lines.push(
      "",
      schema
        ? `Panel plugin \`${cat.pluginId}\`. Options typed from ${GRAFANA_SCHEMA_PIN.source} ${GRAFANA_SCHEMA_PIN.ref} (\`${schema}\`).`
        : `Panel plugin \`${cat.pluginId}\`. Grafana publishes no options schema for it, so GRAF107 does not check its options.`,
    );
  } else if (cat?.kind === "query") {
    lines.push("", `For \`${cat.pluginId}\` datasources. Typed from ${GRAFANA_SCHEMA_PIN.source} ${GRAFANA_SCHEMA_PIN.ref}.`);
  }
  return { contents: lines.join("\n") };
}
