import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { catalogIndex } from "./catalog";
import { postgresHover } from "./postgres";
import { registryIndex } from "./registry";
import { resolveReference } from "./refs";
import { expectAfter, locate, offsetAt, tokensBefore, wordAround } from "./template";

/**
 * Hover for the sql lexicon.
 *
 * Inside a template, a word is looked up in the catalog where the SQL before it
 * says what kind of word it is (an engine after `ENGINE =`, a type where a type
 * goes, a setting after `SETTINGS`), and a function when it is followed by `(`.
 * A `${ref}` shows the table, view or column it points at, with its type.
 * Anywhere else, the entity classes from the generated registry.
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  const pg = postgresHover(ctx);
  if (pg.handled) return pg.info;
  const at = offsetAt(ctx.content, ctx.position);
  const where = locate(ctx.content, at, fileName(ctx.uri));
  if (where) {
    if (where.part < 0) return where.expression < 0 ? undefined : reference(ctx, where.expression, where);
    return catalogHover(where);
  }
  return lexiconHover(ctx, registryIndex(), entityHover);
}

const fileName = (uri: string): string => (uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri) || "file.ts";

function entityHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const [dialect] = entry.resourceType.split("::");
  return { contents: `**${className}**\n\n${dialect} type: \`${entry.resourceType}\`` };
}

function reference(ctx: HoverContext, expression: number, where: NonNullable<ReturnType<typeof locate>>): HoverInfo | undefined {
  const expr = where.found.expressions[expression]!;
  const info = resolveReference(ctx.content, expr.getText(where.source), fileName(ctx.uri));
  return info ? { contents: info } : undefined;
}

function catalogHover(where: NonNullable<ReturnType<typeof locate>>): HoverInfo | undefined {
  const index = catalogIndex();
  if (!index) return undefined;
  const text = where.found.parts[where.part]!;
  const word = wordAround(text, where.offset);
  const name = text.slice(word.start, word.end);
  if (!name) return undefined;
  const sig = tokensBefore(where.found, where.part, word.start);
  if (!sig) return undefined;
  const expect = expectAfter(sig, where.found.tag);
  const followedByParen = /^\s*\(/.test(text.slice(word.end));
  const code = (s: string) => `\`${s}\``;
  let contents: string | undefined;

  const function_ = () => {
    const f = index.functions.get(name) ?? index.functions.get(name.toLowerCase());
    if (!f || !followedByParen) return undefined;
    const alias = f.aliasOf ? `\n\nAlias of ${code(f.aliasOf)}.` : "";
    return `**${f.name}**: ${f.aggregate ? "aggregate function" : "function"}${f.caseInsensitive ? ", case-insensitive" : ""}${alias}`;
  };

  switch (expect) {
    case "engine": {
      const e = where.found.tag === "database" ? index.databaseEngines.get(name) : index.engines.get(name);
      if (e) {
        const caps = where.found.tag === "database" ? [] : Object.entries(index.engines.get(name)!.capabilities).filter(([, on]) => on).map(([k]) => k);
        contents = `**${e.name}** engine\n\n${code(e.syntax)}\n\n${e.summary}${caps.length ? `\n\nSupports: ${caps.join(", ")}.` : ""}`;
      }
      break;
    }
    case "type": {
      const t = index.types.get(name) ?? index.types.get(name.toLowerCase());
      if (t) {
        contents = `**${t.name}**: ClickHouse type family${t.aliasOf ? `, alias of ${code(t.aliasOf)}` : ""}${t.caseInsensitive ? ", case-insensitive" : ""}`;
      }
      break;
    }
    case "codec": {
      const c = index.codecs.get(name);
      if (c) contents = `**${c.name}** codec${c.experimental ? " (experimental)" : ""}\n\n${c.summary}`;
      break;
    }
    case "index-type": {
      const i = index.indexTypes.get(name);
      if (i) contents = `**${i.name}** skip index\n\n${code(i.syntax)}\n\n${i.summary}`;
      break;
    }
    case "merge-tree-setting":
    case "query-setting":
      contents = settingHover(index, name, expect === "merge-tree-setting");
      break;
    case "function":
      contents = function_();
      break;
  }
  // A later setting in a list follows its value, not a comma-or-SETTINGS: look it up by name when it is followed by `=`.
  if (!contents && /^\s*=(?!=)/.test(text.slice(word.end))) contents = settingHover(index, name, where.found.tag !== "view");
  if (!contents) contents = function_();
  return contents ? { contents } : undefined;
}

function settingHover(index: NonNullable<ReturnType<typeof catalogIndex>>, name: string, mergeTreeFirst: boolean): string | undefined {
  const row = mergeTreeFirst
    ? (index.mergeTreeSettings.get(name) ?? index.querySettings.get(name))
    : (index.querySettings.get(name) ?? index.mergeTreeSettings.get(name));
  if (!row) return undefined;
  const scope = index.mergeTreeSettings.get(name) === row ? "MergeTree setting" : "query setting";
  const range = row.min !== undefined || row.max !== undefined ? `, range ${row.min ?? ""}..${row.max ?? ""}` : "";
  const flags = [row.obsolete ? "obsolete" : "", row.readonly ? "read-only" : "", row.tier !== "Production" ? row.tier.toLowerCase() : ""].filter(Boolean);
  return `**${row.name}**: ${scope}\n\nType \`${row.type}\`, default \`${row.default || "''"}\`${range}${flags.length ? ` (${flags.join(", ")})` : ""}\n\n${row.summary}`;
}
