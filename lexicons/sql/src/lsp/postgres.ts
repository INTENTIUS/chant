/**
 * Completions and hover inside Postgres templates (chant #3283). Words come
 * from the committed catalogs of the pinned servers, limited to what the
 * project's major has (`sql.postgresMajor`, else the newest). `${` offers the
 * objects declared in the file and `${t.columns.` their columns with types.
 *
 * Both entry points return undefined when the cursor is not in a Postgres
 * template, so the ClickHouse provider (and the generic registry one) answer.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import * as ts from "typescript";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import {
  describeRange,
  entriesAt,
  entryAt,
  majorFor,
  type Entry,
  type FunctionRow,
  type KeywordRow,
  type MethodRow,
  type SettingRow,
  type StorageRow,
  type TypeRow,
  type ExtensionRow,
} from "./postgres-catalog";
import {
  locatePostgres,
  postgresDeclarations,
  postgresExpectAfter,
  postgresTokensBefore,
  storageTarget,
  type PostgresDeclared,
  type PostgresExpect,
  type PostgresLocated,
} from "./postgres-template";
import { offsetAt, wordAround } from "../core/find-templates";

const LIMIT = 200;
const KEYWORD_CATEGORY: Record<string, string> = { U: "unreserved", C: "column name", T: "type or function name", R: "reserved" };

const fileName = (uri: string): string => (uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri) || "file.ts";
const code = (s: string) => `\`${s}\``;
const matches = (name: string, prefix: string): boolean => prefix === "" || name.toLowerCase().startsWith(prefix.toLowerCase());
const note = (e: Entry<unknown>): string => {
  const r = describeRange(e.range);
  return r ? ` (${r})` : "";
};

/** Completions when the cursor is in a Postgres template; undefined when it is not. */
export function postgresCompletions(ctx: CompletionContext): CompletionItem[] | undefined {
  const file = fileName(ctx.uri);
  const at = offsetAt(ctx.content, ctx.position);
  const where = locatePostgres(ctx.content, at, file);
  if (!where) return undefined;

  const refs = referenceCompletions(ctx, where, file);
  if (refs) return refs;
  if (where.part < 0) return [];

  const text = where.found.parts[where.part]!;
  const word = wordAround(text, where.offset);
  const sig = postgresTokensBefore(where.found, where.part, word.start);
  if (!sig) return [];
  const expect = postgresExpectAfter(sig, where.found.tag);
  if (!expect) return [];
  const prefix = text.slice(word.start, where.offset);
  return fromCatalog(expect, prefix, majorFor(file), storageTarget(sig, where.found.tag));
}

function fromCatalog(expect: PostgresExpect, prefix: string, major: number, target: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const add = (item: CompletionItem) => {
    if (items.length < LIMIT) items.push(item);
  };
  switch (expect) {
    case "type":
      for (const e of entriesAt<TypeRow>("types", major))
        if (matches(e.name, prefix) && e.row.kind !== "m") add({ label: e.name, kind: "value", detail: (e.detail ?? `type, category ${e.row.category}`) + note(e) });
      break;
    case "index-method":
    case "table-method": {
      const want = expect === "index-method" ? "index" : "table";
      for (const e of entriesAt<MethodRow>("accessMethods", major))
        if (e.row.type === want && matches(e.name, prefix)) add({ label: e.name, kind: "value", detail: `${want} access method${note(e)}` });
      break;
    }
    case "storage-parameter":
      for (const e of entriesAt<StorageRow>("storageParameters", major)) {
        if (!e.row.targets.includes(target) || !matches(e.name, prefix)) continue;
        add({ label: e.name, insertText: `${e.name} = `, kind: "property", detail: storageType(e.row) + note(e) });
      }
      break;
    case "extension":
      for (const e of entriesAt<ExtensionRow>("extensions", major))
        if (matches(e.name, prefix)) add({ label: e.name, kind: "value", detail: `extension ${e.row.defaultVersion}`, documentation: e.row.description ?? undefined });
      break;
    case "function":
      if (prefix === "") break;
      for (const e of entriesAt<FunctionRow>("functions", major))
        if (matches(e.name, prefix)) add({ label: e.name, kind: "intrinsic", detail: functionKind(e.row) + note(e) });
      break;
    case "keyword":
      if (prefix.length < 2) break;
      for (const e of entriesAt<KeywordRow>("keywords", major))
        if (matches(e.name, prefix)) add({ label: e.name.toUpperCase(), kind: "value", detail: `${KEYWORD_CATEGORY[e.row.code] ?? "key word"} key word${note(e)}`, documentation: e.row.description });
      break;
  }
  return items;
}

function storageType(row: StorageRow): string {
  const t = row.type as { kind: string; range?: readonly number[]; values?: readonly string[] } | undefined;
  if (!t) return "storage parameter";
  if (t.kind === "enum") return `enum: ${t.values?.join(", ")}`;
  return t.range ? `${t.kind}, range ${t.range[0]}..${t.range[1]}` : t.kind;
}

function functionKind(row: FunctionRow): string {
  const k = row.kinds;
  const what = k.includes("a") ? "aggregate function" : k.includes("w") ? "window function" : k.includes("p") ? "procedure" : "function";
  return row.overloads > 1 ? `${what}, ${row.overloads} overloads` : what;
}

/** `${` offers the file's declared objects; `${t.` offers `columns`; `${t.columns.` offers its columns with their types. */
function referenceCompletions(ctx: CompletionContext, where: PostgresLocated, file: string): CompletionItem[] | undefined {
  const m = /\$\{\s*(?:([A-Za-z_$][\w$]*)\.(columns\.)?)?[\w$]*$/.exec(ctx.linePrefix);
  if (!m) return undefined;
  const self = where.found.node.parent;
  const selfName = self && ts.isVariableDeclaration(self) && ts.isIdentifier(self.name) ? self.name.text : undefined;
  const declared = postgresDeclarations(ctx.content, file).filter((d) => d.name !== selfName);
  const [, owner, columns] = m;
  if (!owner) {
    return declared.map((d) => ({
      label: d.name,
      kind: "resource" as const,
      detail: `${d.kind} ${d.sqlName}`,
      documentation: d.columns.length ? `Columns: ${d.columns.map((c) => c.name).join(", ")}` : undefined,
    }));
  }
  const entity = declared.find((d) => d.name === owner);
  if (!entity) return [];
  if (!columns) return entity.columns.length ? [{ label: "columns", kind: "property", detail: `columns of ${entity.sqlName}` }] : [];
  return entity.columns.map((c) => ({ label: c.name, kind: "property" as const, detail: c.type ?? "column" }));
}

// ── Hover ──────────────────────────────────────────────────────────────

/** Hover when the cursor is in a Postgres template; undefined when it is not (or there is nothing to say). */
export function postgresHover(ctx: HoverContext): { handled: boolean; info?: HoverInfo } {
  const file = fileName(ctx.uri);
  const where = locatePostgres(ctx.content, offsetAt(ctx.content, ctx.position), file);
  if (!where) return { handled: false };
  if (where.part < 0) {
    if (where.expression < 0) return { handled: true };
    const info = resolvePostgresReference(ctx.content, where.found.expressions[where.expression]!.getText(where.source), file);
    return { handled: true, ...(info ? { info: { contents: info } } : {}) };
  }
  const contents = catalogHover(where, majorFor(file));
  return { handled: true, ...(contents ? { info: { contents } } : {}) };
}

function catalogHover(where: PostgresLocated, major: number): string | undefined {
  const text = where.found.parts[where.part]!;
  const word = wordAround(text, where.offset);
  const name = text.slice(word.start, word.end);
  if (!name) return undefined;
  const sig = postgresTokensBefore(where.found, where.part, word.start);
  if (!sig) return undefined;
  const expect = postgresExpectAfter(sig, where.found.tag);
  const after = text.slice(word.end);
  const followedByParen = /^\s*\(/.test(after);

  const type = () => {
    const e = entryAt<TypeRow>("types", name, major);
    if (!e) return undefined;
    const alias = e.row.aliasOf ? `, alias of ${code(e.row.aliasOf)}` : "";
    return `**${e.name}**: Postgres type${alias}${note(e)}\n\nCategory ${code(e.row.category)}, catalog name ${code(e.row.catalogName)}.`;
  };
  const method = () => {
    const e = entryAt<MethodRow>("accessMethods", name, major);
    if (!e) return undefined;
    const props = e.row.properties.length ? `\n\nProperties: ${e.row.properties.join(", ")}.` : "";
    return `**${e.name}**: ${e.row.type} access method${note(e)}${props}`;
  };
  const storage = () => {
    const e = entryAt<StorageRow>("storageParameters", name, major);
    return e ? `**${e.name}**: storage parameter${note(e)}\n\n${storageType(e.row)}. Applies to: ${e.row.targets.join(", ")}.` : undefined;
  };
  const fn = () => {
    const e = entryAt<FunctionRow>("functions", name, major);
    return e && followedByParen ? `**${e.name}**: ${functionKind(e.row)}${note(e)}` : undefined;
  };
  const keyword = () => {
    const e = entryAt<KeywordRow>("keywords", name, major);
    return e ? `**${e.name.toUpperCase()}**: ${KEYWORD_CATEGORY[e.row.code] ?? "key word"} key word${note(e)}\n\n${e.row.description}` : undefined;
  };
  const extension = () => {
    const e = entryAt<ExtensionRow>("extensions", name, major);
    return e ? `**${e.name}**: extension ${e.row.defaultVersion}${note(e)}${e.row.description ? `\n\n${e.row.description}` : ""}` : undefined;
  };
  const setting = () => {
    const e = entryAt<SettingRow>("settings", name, major);
    if (!e) return undefined;
    const r = e.row;
    const range = r.min !== null || r.max !== null ? `, range ${r.min ?? ""}..${r.max ?? ""}` : "";
    return `**${e.name}**: server setting${note(e)}\n\nType ${code(r.type)}, default ${code(r.default ?? "")}${r.unit ? ` ${r.unit}` : ""}${range}, changed at ${r.context}.`;
  };

  switch (expect) {
    case "type":
      return type() ?? keyword();
    case "index-method":
    case "table-method":
      return method();
    case "storage-parameter":
      return storage();
    case "extension":
      return extension();
  }
  if (/^\s*=(?!=)/.test(after)) {
    const s = storage();
    if (s) return s;
  }
  return fn() ?? keyword() ?? setting();
}

// ── References ─────────────────────────────────────────────────────────

function importedFrom(content: string, local: string, file: string): PostgresDeclared | undefined {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => e.name.text === local);
    if (!el) continue;
    const base = resolve(dirname(file), spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
      if (!existsSync(candidate)) continue;
      const found = postgresDeclarations(readFileSync(candidate, "utf-8"), candidate).find((d) => d.name === (el.propertyName ?? el.name).text);
      if (found) return found;
    }
  }
  return undefined;
}

const describe = (d: PostgresDeclared): string => {
  const lines = [`**${d.name}**: Postgres ${d.kind} \`${d.sqlName}\``];
  if (d.columns.length) lines.push(`Columns: ${d.columns.map((c) => `\`${c.name}${c.type ? ` ${c.type}` : ""}\``).join(", ")}`);
  return lines.join("\n\n");
};

/** Hover text for the expression written in a `${}`, or undefined when it is not a reference this can follow. */
export function resolvePostgresReference(content: string, expression: string, file: string): string | undefined {
  const m = /^([A-Za-z_$][\w$]*)(?:\.columns(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\]))?$/.exec(expression.trim());
  if (!m) return undefined;
  const [, owner, dotted, bracketed] = m;
  const column = dotted ?? bracketed;
  const declared = postgresDeclarations(content, file).find((d) => d.name === owner) ?? importedFrom(content, owner!, file);
  if (!declared) return undefined;
  if (!column) return describe(declared);
  const c = declared.columns.find((x) => x.name === column);
  if (!c) return `**${owner}.columns.${column}**: no column \`${column}\` in ${declared.sqlName}. Columns: ${declared.columns.map((x) => x.name).join(", ")}`;
  return `**${owner}.columns.${column}**: column \`${c.name}\` of ${declared.kind} \`${declared.sqlName}\`${c.type ? `, type \`${c.type}\`` : ""}`;
}
