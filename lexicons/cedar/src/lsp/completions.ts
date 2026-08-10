import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { cedarIndex, cedarRegistry } from "./registry";

/**
 * Completions over the schema-derived registry.
 *
 * Two shapes come out of core's generic provider: class names after `new `,
 * and property names inside a constructor's object literal. Both are useful
 * here — `new Policy({` completes `effect`/`principal`/`action`/…, and
 * `new Doc` completes `Document`.
 *
 * The third shape is Cedar's own: a scope names an *action constant*, not a
 * class, and those are plain `const` exports rather than constructors, so no
 * `new ` ever precedes them. {@link actionCompletions} covers that position.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  const generic = lexiconCompletions(ctx, cedarIndex(), "Cedar declaration");
  if (generic.length > 0) return generic;
  return actionCompletions(ctx);
}

/**
 * Action constants in a scope position.
 *
 * `action: { eq: <cursor> }` and `action: { in: [<cursor>` are where an action
 * is named, and the generated constants (`ReadAction`, `WriteAction`, …) are
 * the only correct values. Matching on the surrounding text rather than on a
 * parsed AST keeps this cheap and is what the other lexicons' providers do.
 */
export function actionCompletions(ctx: CompletionContext): CompletionItem[] {
  const linePrefix = ctx.linePrefix ?? "";
  if (!/\baction\s*:\s*\{\s*(eq|in)\s*:\s*\[?\s*[A-Za-z]*$/.test(linePrefix)) return [];

  const prefix = (ctx.wordAtCursor ?? "").toLowerCase();
  const registry = cedarRegistry();

  return Object.entries(registry)
    .filter(([, entry]) => entry.kind === "resource" && entry.resourceType.includes("::Action::"))
    .filter(([className]) => !prefix || className.toLowerCase().startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([className, entry]) => ({
      label: className,
      insertText: className,
      kind: "resource" as const,
      detail: entry.resourceType,
      documentation: [
        `Cedar action: \`${entry.resourceType}\``,
        entry.principalTypes?.length ? `Principals: ${entry.principalTypes.join(", ")}` : "",
        entry.resourceTypes?.length ? `Resources: ${entry.resourceTypes.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }));
}
