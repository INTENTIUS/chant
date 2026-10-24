import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { lexiconRegistry } from "../catalog";
import { propertiesAt, propertyMarkdown, propertyPosition } from "./properties";

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  cachedIndex ??= new LexiconIndex(lexiconRegistry());
  return cachedIndex;
}

/** The text of `content` before the cursor. */
export function textBefore(content: string, position: { line: number; character: number }): string {
  const lines = content.split("\n");
  return [...lines.slice(0, position.line), (lines[position.line] ?? "").slice(0, position.character)].join("\n");
}

/**
 * Completions for the otel entity classes after `new`, and inside a built-in's
 * constructor, the config properties at the cursor's depth, with upstream's
 * descriptions (#3361).
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  if (ctx?.content && ctx.position && !/\bnew\s+\w*$/.test(ctx.linePrefix ?? "")) {
    const position = propertyPosition(textBefore(ctx.content, ctx.position));
    const props = position && propertiesAt(position);
    if (position && props) {
      const prefix = (ctx.wordAtCursor ?? "").toLowerCase();
      return Object.entries(props)
        .filter(([name]) => name.toLowerCase().startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, doc]) => ({
          label: name,
          insertText: name,
          kind: "property" as const,
          detail: doc.type,
          documentation: propertyMarkdown(name, doc, position.className),
          ...(doc.deprecated ? { deprecated: true } : {}),
        }));
    }
  }
  return lexiconCompletions(ctx, getIndex(), "OpenTelemetry Collector entity");
}
