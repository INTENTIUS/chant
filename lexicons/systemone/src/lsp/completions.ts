/**
 * LSP completions for the systemone lexicon: the `decide` step's option keys
 * inside `decide("<point>", { ... })`, and the keys of the `systemone` config
 * namespace, a backend and a key. There is no generated resource index, since
 * the lexicon declares no resources.
 */

import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { BACKEND_KEYS, CONFIG_KEYS, DECIDE_KEYS, KEY_KEYS, type OptionKey } from "./keys";

function keyCompletions(keys: OptionKey[], prefix: string): CompletionItem[] {
  const lower = prefix.toLowerCase();
  return keys
    .filter((k) => !lower || k.key.toLowerCase().startsWith(lower))
    .map((k) => ({ label: k.key, insertText: k.key, kind: "property" as const, documentation: k.detail }));
}

/** The innermost unclosed `{` and the text just before it, up to the cursor. */
function openers(text: string): string[] {
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}") stack.pop();
  }
  return stack.map((i) => text.slice(Math.max(0, i - 80), i));
}

function upTo(content: string, line: number, linePrefix: string): string {
  const lines = content.split("\n").slice(0, line);
  return `${lines.join("\n")}\n${linePrefix}`;
}

export function completions(ctx: CompletionContext): CompletionItem[] {
  const prefix = ctx.wordAtCursor ?? "";
  const text = upTo(ctx.content ?? "", ctx.position?.line ?? 0, ctx.linePrefix ?? "");
  const before = openers(text);
  const inner = before[before.length - 1];
  if (inner === undefined) return [];
  if (/\bdecide\(\s*["'][^"']*["']\s*,\s*$/.test(inner)) return keyCompletions(DECIDE_KEYS, prefix);
  if (/\bsystemone\s*:\s*$/.test(inner)) return keyCompletions(CONFIG_KEYS, prefix);
  if (/\bkey\s*:\s*$/.test(inner)) return keyCompletions(KEY_KEYS, prefix);
  const outer = before[before.length - 2];
  if (outer !== undefined && /\bbackends\s*:\s*$/.test(outer)) return keyCompletions(BACKEND_KEYS, prefix);
  return [];
}
