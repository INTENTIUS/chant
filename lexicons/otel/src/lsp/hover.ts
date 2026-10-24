import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { BUILTIN_CATALOG, lexiconRegistry } from "../catalog";
import { COLLECTOR_PIN } from "../define";
import { propertiesAt, propertyMarkdown, propertyPosition } from "./properties";
import { textBefore } from "./completions";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/**
 * Hover for otel entity classes (what the component does and its collector
 * id), and for a config property inside a built-in's constructor (upstream's
 * description, #3361).
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  const entity = lexiconHover(ctx, getIndex(), resourceHover);
  if (entity) return entity;
  if (!ctx?.content || !ctx.position || !ctx.word) return undefined;
  const position = propertyPosition(textBefore(ctx.content, ctx.position));
  const doc = position && propertiesAt(position)?.[ctx.word];
  return position && doc ? { contents: propertyMarkdown(ctx.word, doc, position.className) } : undefined;
}

function resourceHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const cat = BUILTIN_CATALOG.find((c) => c.className === className);
  const lines = [`**${className}**`, "", `otel type: \`${entry.resourceType}\``];
  if (cat?.description) lines.push("", cat.description);
  if (cat?.type) {
    lines.push(
      "",
      `Collector id \`${cat.type}\`, or \`${cat.type}/<name>\` with \`name\` set. ` +
        `Config typed from upstream config.schema.yaml at ${COLLECTOR_PIN.source} ${COLLECTOR_PIN.version}.`,
    );
  }
  return { contents: lines.join("\n") };
}
