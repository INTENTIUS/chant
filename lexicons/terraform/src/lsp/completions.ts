/**
 * LSP completions for the terraform lexicon (#2088).
 *
 * k3s's shape (a generated `LexiconIndex` over typed resource classes) does
 * not fit here: terraform's declarables are lightweight per-HCL-block
 * entities `buildRoots()` produces at build time, not authored TypeScript
 * types — there is nothing to generate a completion index from. What an
 * ops-only lexicon can honestly complete is the surface an `*.op.ts` author
 * actually types:
 *
 *   - `terraform.roots` names, read from the reachable `chant.config.*` (see
 *     `./context.ts`) — completed inside a root-name position, e.g.
 *     `terraformPlan("` or `root: "`.
 *   - the composite/builder option keys (`./option-keys.ts`) — completed
 *     inside the relevant call's options object.
 *
 * Root names complete only when a `chant.config.*` is reachable from the
 * document's own `uri` and declares at least one; there is no synchronous,
 * safe way to evaluate `chant.config.ts` (project-authored code) from inside
 * a completion request, so an unreachable config yields no root-name
 * completions rather than a guessed one. Option keys need no config at all
 * and complete unconditionally.
 */

import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { contentUpToCursor, enclosingCallName, enclosingKeyPath, innermostObjectKey, resolveRootsForUri } from "./context";
import { APPLY_OP_KEYS, BUILDER_OPTS_BY_CALL, COMPENSATE_KEYS, CONFIG_NAMESPACE_KEYS, ROOT_ENTRY_KEYS, type OptionKey } from "./option-keys";

/** `terraformPlan("` / `terraformApply(` — the first positional string arg, which every builder types as `root`. */
const ROOT_POSITIONAL_ARG = new RegExp(`\\b(${Object.keys(BUILDER_OPTS_BY_CALL).join("|")})\\(\\s*["'](\\w*)$`);

/** `root: "` — the named field, in `TerraformApplyOp({ ... })` or a raw `activity("terraformPlan", { root: "..." })`. */
const ROOT_NAMED_FIELD = /\broot\s*:\s*["'](\w*)$/;

function keyCompletions(keys: OptionKey[], prefix: string): CompletionItem[] {
  const lower = prefix.toLowerCase();
  return keys
    .filter((k) => !lower || k.key.toLowerCase().startsWith(lower))
    .map((k) => ({
      label: k.key,
      insertText: k.key,
      kind: "property" as const,
      documentation: k.detail,
    }));
}

function rootCompletions(uri: string, prefix: string): CompletionItem[] {
  const roots = resolveRootsForUri(uri);
  if (!roots) return [];
  const lower = prefix.toLowerCase();
  return Object.entries(roots)
    .filter(([name]) => !lower || name.toLowerCase().startsWith(lower))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, root]) => ({
      label: name,
      insertText: name,
      kind: "value" as const,
      detail: root.dir,
      documentation: [
        root.dir ? `dir: ${root.dir}` : undefined,
        root.workspace ? `workspace: ${root.workspace}` : undefined,
        root.varFiles?.length ? `varFiles: ${root.varFiles.join(", ")}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    }));
}

export function completions(ctx: CompletionContext): CompletionItem[] {
  const linePrefix = ctx.linePrefix ?? "";

  const positional = ROOT_POSITIONAL_ARG.exec(linePrefix);
  if (positional) return rootCompletions(ctx.uri, positional[2]);

  const namedField = ROOT_NAMED_FIELD.exec(linePrefix);
  if (namedField) return rootCompletions(ctx.uri, namedField[1]);

  const upToCursor = contentUpToCursor(ctx.content ?? "", ctx.position?.line ?? 0);
  const prefix = ctx.wordAtCursor ?? "";

  const call = enclosingCallName(upToCursor);
  if (call === "TerraformApplyOp") return keyCompletions(APPLY_OP_KEYS, prefix);
  if (call && call in BUILDER_OPTS_BY_CALL) return keyCompletions(BUILDER_OPTS_BY_CALL[call], prefix);

  // `compensate: { <cursor>` — checked independent of the call chain above,
  // since `compensate` itself sits inside `TerraformApplyOp({ ... })`'s own
  // argument object, which `enclosingKeyPath` below refuses to walk through.
  if (innermostObjectKey(upToCursor) === "compensate") return keyCompletions(COMPENSATE_KEYS, prefix);

  // The remaining contexts are all plain nested object literals with no call
  // in the chain — `chant.config.ts`'s own `terraform: { ... }` namespace.
  const path = enclosingKeyPath(upToCursor);
  if (path) {
    const last = path[path.length - 1];
    const parent = path[path.length - 2];
    if (parent === "roots") return keyCompletions(ROOT_ENTRY_KEYS, prefix);
    if (last === "terraform") return keyCompletions(CONFIG_NAMESPACE_KEYS, prefix);
  }

  return [];
}
