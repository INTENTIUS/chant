/**
 * LSP hover for the pulumi lexicon (#4468), over the same four files
 * `./completions.ts` completes: a key in `Pulumi.yaml` or a stack's config
 * says what it is and what chant does with it, `"kind": "pulumi"` in the
 * workspace declaration says what chant reads from the member and runs
 * against it, and a key of `pulumi.member` in `chant.config.ts` says what it
 * sets.
 */
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { pulumiDocument, uriDir } from "./documents";
import { projectName } from "./completions";
import { CONFIG_NAMESPACE_KEYS, MEMBER_CONFIG_KEYS, MEMBER_KIND_DOC, PROJECT_KEYS, STACK_CONFIG_VALUE_KEYS, STACK_KEYS, type KeyDoc } from "./keys";
import { endsWith, enclosingKeys, offsetOf } from "./object-path";
import { yamlKeyAt } from "./yaml-cursor";

function keyHover(entry: KeyDoc | undefined, label: string): HoverInfo | undefined {
  return entry ? { contents: `**${label}**\n\n${entry.doc}` } : undefined;
}

function yamlHover(table: Record<string, KeyDoc[]>, ctx: HoverContext): HoverInfo | undefined {
  const at = yamlKeyAt(ctx.content ?? "", ctx.position?.line ?? 0);
  if (!at || !ctx.word) return undefined;
  const entry = table[at.path.slice(0, -1).join(".")]?.find((k) => k.key === at.key);
  if (!entry) return undefined;
  if (at.key.includes(ctx.word)) return keyHover(entry, at.path.join("."));
  const value = entry.values?.find((v) => v.value === ctx.word && at.value.replace(/^["']|["']$/g, "") === v.value);
  return value ? { contents: `**${at.key}: ${value.value}**\n\n${value.doc}` } : undefined;
}

function stackHover(ctx: HoverContext): HoverInfo | undefined {
  const at = yamlKeyAt(ctx.content ?? "", ctx.position?.line ?? 0);
  if (!at || !ctx.word) return undefined;
  if (at.path.length === 2 && at.path[0] === "config" && at.key.includes(ctx.word)) {
    const colon = at.key.indexOf(":");
    if (colon === -1) return undefined;
    const namespace = at.key.slice(0, colon);
    const own = namespace === projectName(uriDir(ctx.uri));
    return {
      contents:
        `**${at.key}**\n\n` +
        (own
          ? `This project's config key \`${at.key.slice(colon + 1)}\`, read by the program with \`new pulumi.Config()\`.`
          : `Config for the \`${namespace}\` package or provider, key \`${at.key.slice(colon + 1)}\`.`),
    };
  }
  if (at.path.length === 3 && at.path[0] === "config" && STACK_CONFIG_VALUE_KEYS[at.key] && at.key === ctx.word) {
    return { contents: `**${at.key}**\n\n${STACK_CONFIG_VALUE_KEYS[at.key]}` };
  }
  return yamlHover(STACK_KEYS, ctx);
}

function workspaceHover(ctx: HoverContext): HoverInfo | undefined {
  if (ctx.word !== "pulumi" || !/"kind"\s*:\s*"pulumi"/.test(ctx.lineText ?? "")) return undefined;
  return { contents: MEMBER_KIND_DOC };
}

function configHover(ctx: HoverContext): HoverInfo | undefined {
  const content = ctx.content ?? "";
  const line = ctx.lineText ?? "";
  const word = ctx.word ?? "";
  if (!word || !new RegExp(`\\b${word}\\s*:`).test(line)) return undefined;
  const before = content.slice(0, offsetOf(content, ctx.position?.line ?? 0, line.indexOf(word)));
  const path = enclosingKeys(before);
  if (endsWith(path, ["pulumi", "member"])) return keyHover(MEMBER_CONFIG_KEYS.find((k) => k.key === word), `pulumi.member.${word}`);
  if (endsWith(path, ["pulumi"])) return keyHover(CONFIG_NAMESPACE_KEYS.find((k) => k.key === word), `pulumi.${word}`);
  return undefined;
}

export function hover(ctx: HoverContext): HoverInfo | undefined {
  const doc = pulumiDocument(ctx.uri ?? "");
  switch (doc?.kind) {
    case "project":
      return yamlHover(PROJECT_KEYS, ctx);
    case "stack":
      return stackHover(ctx);
    case "workspace":
      return workspaceHover(ctx);
    case "config":
      return configHover(ctx);
    default:
      return undefined;
  }
}
