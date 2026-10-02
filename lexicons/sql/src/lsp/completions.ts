import * as ts from "typescript";
import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
import { lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";
import { catalogIndex, type CatalogIndex } from "./catalog";
import { registryIndex } from "./registry";
import { declarations, expectAfter, locate, offsetAt, tokensBefore, wordAround, type Expect } from "./template";
import type { SqlTag } from "../lint/rules/templates";

const LIMIT = 200;

/**
 * Completions for the sql lexicon.
 *
 * Inside a `table`, `view` or `database` template they come from the catalog of
 * the pinned ClickHouse server: engines after `ENGINE =`, type families where a
 * column's type goes, codecs inside `CODEC(...)`, skip index types after `TYPE`,
 * settings after `SETTINGS`, functions in expressions. Inside `${` they are the
 * tables and views declared in the file and their columns. Anywhere else, the
 * entity classes from the generated registry.
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  const refs = interpolationCompletions(ctx);
  if (refs) return refs;

  const at = offsetAt(ctx.content, ctx.position);
  const where = locate(ctx.content, at, fileName(ctx.uri));
  if (where && where.part >= 0) {
    const index = catalogIndex();
    if (!index) return [];
    const text = where.found.parts[where.part]!;
    const word = wordAround(text, where.offset);
    const sig = tokensBefore(where.found, where.part, word.start);
    if (!sig) return [];
    const expect = expectAfter(sig, where.found.tag);
    if (!expect) return [];
    const prefix = text.slice(word.start, where.offset);
    return fromCatalog(index, expect, where.found.tag, prefix);
  }
  if (where) return [];
  return lexiconCompletions(ctx, registryIndex(), "sql entity");
}

const fileName = (uri: string): string => (uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri) || "file.ts";

const matches = (name: string, prefix: string, fold: boolean): boolean =>
  prefix === "" || (fold ? name.toLowerCase().startsWith(prefix.toLowerCase()) : name.startsWith(prefix));

function fromCatalog(index: CatalogIndex, expect: Expect, tag: SqlTag, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const add = (item: CompletionItem) => {
    if (items.length < LIMIT) items.push(item);
  };
  const { catalog } = index;
  switch (expect) {
    case "engine":
      if (tag === "database") {
        for (const e of catalog.databaseEngines)
          if (matches(e.name, prefix, true)) add({ label: e.name, kind: "value", detail: e.syntax, documentation: e.summary });
      } else {
        for (const e of catalog.tableEngines)
          if (matches(e.name, prefix, true)) add({ label: e.name, kind: "value", detail: e.syntax, documentation: e.summary });
      }
      break;
    case "type":
      for (const t of catalog.typeFamilies)
        if (matches(t.name, prefix, t.caseInsensitive))
          add({ label: t.name, kind: "value", detail: t.aliasOf ? `alias of ${t.aliasOf}` : "type family" });
      break;
    case "codec":
      for (const c of catalog.codecs)
        if (matches(c.name, prefix, true)) add({ label: c.name, kind: "value", detail: codecKind(c), documentation: c.summary });
      break;
    case "index-type":
      for (const i of catalog.skipIndexTypes)
        if (matches(i.name, prefix, false)) add({ label: i.name, kind: "value", detail: i.syntax, documentation: i.summary });
      break;
    case "merge-tree-setting":
    case "query-setting": {
      const rows = expect === "merge-tree-setting" ? catalog.mergeTreeSettings : catalog.querySettings;
      for (const s of rows) {
        if (s.obsolete || !matches(s.name, prefix, false)) continue;
        add({ label: s.name, insertText: `${s.name} = `, kind: "property", detail: `${s.type}, default ${s.default || "''"}`, documentation: s.summary });
      }
      break;
    }
    case "function":
      if (prefix === "") break;
      for (const f of catalog.functions)
        if (!f.aliasOf && matches(f.name, prefix, f.caseInsensitive))
          add({ label: f.name, kind: "intrinsic", detail: f.aggregate ? "aggregate function" : "function" });
      break;
  }
  return items;
}

function codecKind(c: { compression: boolean; encryption: boolean; timeseries: boolean }): string {
  return c.encryption ? "encryption codec" : c.timeseries ? "time series codec" : c.compression ? "compression codec" : "codec";
}

/** `${` offers the file's tables and views; `${t.` offers `columns`; `${t.columns.` offers its columns. */
function interpolationCompletions(ctx: CompletionContext): CompletionItem[] | undefined {
  const before = ctx.content.slice(0, offsetAt(ctx.content, ctx.position));
  if (!before.includes("chant-lexicon-sql") && !ctx.content.includes("chant-lexicon-sql")) return undefined;
  const m = /\$\{\s*(?:([A-Za-z_$][\w$]*)\.(columns\.)?)?[\w$]*$/.exec(ctx.linePrefix);
  if (!m) return undefined;
  // Inside a template: an odd number of backticks before the cursor.
  if ((before.match(/`/g)?.length ?? 0) % 2 === 0) return undefined;
  // The template being written is not something it can refer to.
  const self = locate(ctx.content, offsetAt(ctx.content, ctx.position), fileName(ctx.uri))?.found.node.parent;
  const selfName = self && ts.isVariableDeclaration(self) && ts.isIdentifier(self.name) ? self.name.text : undefined;
  const declared = declarations(ctx.content, fileName(ctx.uri)).filter((d) => d.name !== selfName);
  const [, owner, columns] = m;
  if (!owner) {
    return declared.map((d) => ({
      label: d.name,
      kind: "resource" as const,
      detail: `${d.materialized ? "materialized view" : d.tag} ${d.sqlName}`,
      documentation: d.columns.length ? `Columns: ${d.columns.map((c) => c.name).join(", ")}` : undefined,
    }));
  }
  const entity = declared.find((d) => d.name === owner);
  if (!entity) return [];
  if (!columns) return entity.columns.length ? [{ label: "columns", kind: "property", detail: `columns of ${entity.sqlName}` }] : [];
  return entity.columns.map((c) => ({ label: c.name, kind: "property" as const, detail: c.type ?? "column" }));
}
