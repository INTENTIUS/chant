/**
 * LSP completions for the augur lexicon (#2357).
 *
 * The generated-`LexiconIndex` shape most lexicons use does not fit here for
 * the reason `lexicons/terraform/src/lsp/completions.ts` gives: there is no
 * generated registry to index, because there is no upstream schema. What augur
 * can honestly complete is what an author actually types:
 *
 *  - the two `Profile` option keys, inside a `Profile({ … })` construction;
 *  - an entity type, inside a quoted string, from the coverage table — because
 *    "will this kind be priced" is the question the table exists to answer, and
 *    an author asking it should not have to open `mapping.ts` to find out.
 *
 * A mapped type completes with its engine kind in `detail`; a declared-unmapped
 * one completes too, marked, with its reason. Both, not just the mapped half:
 * offering only the priced kinds would let an author conclude from an absent
 * completion that a type is unknown, when the table has looked at it and
 * decided. That is the same absent-versus-unread distinction the report itself
 * is built on, and it does not stop at the editor.
 */

import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { byCodeUnit, DECLARED_UNMAPPED, ENGINE_KINDS_BY_ENTITY_TYPE } from "../mapping";

/** The `Profile` properties, with what each one is for. */
export const PROFILE_KEYS: ReadonlyArray<{ key: string; detail: string }> = [
  {
    key: "traffic",
    detail:
      "The traffic level to predict at, verbatim: \"1000 rps, p99\". Handed to the engine unparsed; " +
      "AUG001 reports a bare quantity.",
  },
  {
    key: "description",
    detail: "What this level is, for a reader of the report. Optional, and never sent to the engine.",
  },
];

/** `Profile({` / `new Profile({` — anywhere in the line before the cursor. */
const IN_PROFILE = /\bProfile\s*\(\s*\{[^}]*$/;

/** An unterminated quoted string at the cursor, with whatever has been typed of it. */
const OPEN_STRING = /["']([A-Za-z0-9:_-]*)$/;

export function completions(ctx: CompletionContext): CompletionItem[] {
  const prefix = ctx.linePrefix ?? "";

  const open = OPEN_STRING.exec(prefix);
  if (open) return typeCompletions(open[1]);

  if (IN_PROFILE.test(prefix)) {
    const typed = (ctx.wordAtCursor ?? "").toLowerCase();
    return PROFILE_KEYS.filter((k) => !typed || k.key.toLowerCase().startsWith(typed)).map((k) => ({
      label: k.key,
      insertText: k.key,
      kind: "property" as const,
      documentation: k.detail,
    }));
  }

  return [];
}

function typeCompletions(typed: string): CompletionItem[] {
  const lower = typed.toLowerCase();
  // Nothing typed yet is not a request for 30 entity types in an arbitrary
  // string position; two characters in, it is.
  if (lower.length < 2) return [];
  const items: CompletionItem[] = [];
  for (const [entityType, mapping] of Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE)) {
    if (!entityType.toLowerCase().includes(lower)) continue;
    items.push({
      label: entityType,
      insertText: entityType,
      kind: "value",
      detail: `${mapping.kind} (${mapping.provider})`,
      documentation: mapping.sizeProp
        ? `Sent to the engine as a ${mapping.kind}; its size is read from \`${mapping.sizeProp}\`.`
        : `Sent to the engine as a ${mapping.kind}, with no size stated.`,
    });
  }
  for (const [entityType, reason] of Object.entries(DECLARED_UNMAPPED)) {
    if (!entityType.toLowerCase().includes(lower)) continue;
    items.push({
      label: entityType,
      insertText: entityType,
      kind: "value",
      detail: "declared unmapped",
      documentation: `Not sent to the engine: ${reason}. It is reported as \`unsupported-kind\`, never as zero.`,
    });
  }
  return items.sort((a, b) => byCodeUnit(a.label, b.label));
}
