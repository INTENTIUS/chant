/**
 * LSP completions for the pulumi lexicon (#4468).
 *
 * There is no typed resource surface to complete (the lexicon declares no
 * kinds), so this completes the files a pulumi member is made of, the way
 * the terraform lexicon completes its config and builder options rather than
 * HCL types:
 *
 * - `Pulumi.yaml`: the project keys, at the level the cursor is on, and the
 *   values of `runtime` and the few other keys with a closed set;
 * - `Pulumi.<stack>.yaml`: the stack keys, and under `config:` the project's
 *   own namespace (`<name>:`), read from the `Pulumi.yaml` beside it;
 * - `chant.workspace.json`: `pulumi` as a member's `"kind"`;
 * - `chant.config.ts`: the `pulumi` namespace's `member` and its keys, and
 *   `engine`'s two values.
 *
 * See `./documents.ts` for how a document is recognised and `./keys.ts` for
 * what each key says.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { pulumiDocument, uriDir } from "./documents";
import { CONFIG_NAMESPACE_KEYS, MEMBER_CONFIG_KEYS, MEMBER_KIND_DOC, PROJECT_KEYS, STACK_KEYS, type KeyDoc } from "./keys";
import { endsWith, enclosingKeys, offsetOf } from "./object-path";
import { yamlCursor } from "./yaml-cursor";

function keyItems(keys: KeyDoc[], prefix: string): CompletionItem[] {
  const lower = prefix.toLowerCase();
  return keys
    .filter((k) => !lower || k.key.toLowerCase().startsWith(lower))
    .map((k) => ({ label: k.key, insertText: k.key, kind: "property" as const, documentation: k.doc }));
}

function valueItems(key: KeyDoc | undefined, prefix: string): CompletionItem[] {
  const lower = prefix.trim().replace(/^["']/, "").toLowerCase();
  return (key?.values ?? [])
    .filter((v) => !lower || v.value.toLowerCase().startsWith(lower))
    .map((v) => ({ label: v.value, insertText: v.value, kind: "value" as const, documentation: v.doc }));
}

function yamlCompletions(table: Record<string, KeyDoc[]>, ctx: CompletionContext): CompletionItem[] {
  const cursor = yamlCursor(ctx.content ?? "", ctx.position?.line ?? 0, ctx.position?.character ?? 0);
  const keys = table[cursor.parents.join(".")];
  if (!keys) return [];
  if (cursor.key !== undefined) return valueItems(keys.find((k) => k.key === cursor.key), cursor.valuePrefix);
  return keyItems(keys, cursor.keyPrefix);
}

/** The `name:` of the `Pulumi.yaml` in `dir`, when there is one. */
export function projectName(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  for (const file of ["Pulumi.yaml", "Pulumi.yml"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const m = /^name:\s*["']?([^\s"'#]+)/m.exec(readFileSync(path, "utf-8"));
      return m?.[1];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stackCompletions(ctx: CompletionContext): CompletionItem[] {
  const cursor = yamlCursor(ctx.content ?? "", ctx.position?.line ?? 0, ctx.position?.character ?? 0);
  if (cursor.parents.length === 1 && cursor.parents[0] === "config" && cursor.key === undefined) {
    const name = projectName(uriDir(ctx.uri));
    if (!name || !`${name}:`.startsWith(cursor.keyPrefix)) return [];
    return [
      {
        label: `${name}:`,
        insertText: `${name}:`,
        kind: "property",
        detail: "this project's config namespace",
        documentation: `Config the program reads with \`new pulumi.Config()\`, keyed \`${name}:<key>\`.`,
      },
    ];
  }
  return yamlCompletions(STACK_KEYS, ctx);
}

function workspaceCompletions(ctx: CompletionContext): CompletionItem[] {
  const m = /"kind"\s*:\s*"([\w-]*)$/.exec(ctx.linePrefix ?? "");
  if (!m || !"pulumi".startsWith(m[1])) return [];
  const before = (ctx.content ?? "").slice(0, offsetOf(ctx.content ?? "", ctx.position?.line ?? 0, ctx.position?.character ?? 0));
  if (!enclosingKeys(before).includes("members")) return [];
  return [{ label: "pulumi", insertText: "pulumi", kind: "value", detail: "a Pulumi program, with a Pulumi.yaml", documentation: MEMBER_KIND_DOC }];
}

function configCompletions(ctx: CompletionContext): CompletionItem[] {
  const content = ctx.content ?? "";
  const before = content.slice(0, offsetOf(content, ctx.position?.line ?? 0, ctx.position?.character ?? 0));
  const path = enclosingKeys(before);
  const engine = /\bengine\s*:\s*["']([\w]*)$/.exec(ctx.linePrefix ?? "");
  if (engine) {
    return endsWith(path, ["pulumi", "member"]) ? valueItems(MEMBER_CONFIG_KEYS.find((k) => k.key === "engine"), engine[1]) : [];
  }
  if (endsWith(path, ["pulumi", "member"])) return keyItems(MEMBER_CONFIG_KEYS, ctx.wordAtCursor ?? "");
  if (endsWith(path, ["pulumi"])) return keyItems(CONFIG_NAMESPACE_KEYS, ctx.wordAtCursor ?? "");
  return [];
}

export function completions(ctx: CompletionContext): CompletionItem[] {
  const doc = pulumiDocument(ctx.uri ?? "");
  switch (doc?.kind) {
    case "project":
      return yamlCompletions(PROJECT_KEYS, ctx);
    case "stack":
      return stackCompletions(ctx);
    case "workspace":
      return workspaceCompletions(ctx);
    case "config":
      return configCompletions(ctx);
    default:
      return [];
  }
}
