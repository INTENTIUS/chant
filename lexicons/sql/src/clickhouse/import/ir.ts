/**
 * ClickHouse DDL into the import IR, and back out as `database`, `table` and
 * `view` declarations.
 *
 * `chant import --from <env>` reads each object's `SHOW CREATE` and `chant
 * import schema.sql` reads a file of CREATE statements; both arrive here as
 * statements. The generated declaration is the statement itself, the
 * server's canonical form when it came from a server (#3046 question 5), with
 * two changes:
 *
 * - a qualified name of another imported object becomes a reference to its
 *   export (`FROM analytics.events` is `FROM ${events}`), and the database
 *   part of an object's own name becomes a reference to the database's export,
 *   so dependency order survives the import;
 * - a backquoted identifier that needs no quoting is written bare, and one that
 *   does is double-quoted, so the template has no backquotes to escape.
 *
 * Columns written by name inside a view's SELECT stay text: which table a
 * bare name belongs to is the server's to resolve, and a guess would be
 * wrong lineage. An imported view therefore records its reads, not its column
 * lineage, until its column references are written as `${t.columns.c}`.
 */

import type { ResourceIR, TemplateIR } from "@intentius/chant/import/parser";
import { isTrivia, tokenizeText, untokenize, type Token } from "../tokens";
import { parseCreate, unquote, type CreateNode, type Span } from "../parser";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "../entities";
import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";

export interface ImportedObject {
  type: ClickHouseEntityType;
  database?: string;
  name: string;
  /** The CREATE statement. */
  ddl: string;
}

const JS_RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
);

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "object";
  const s = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
  return /^[0-9]/.test(s) ? `t${s}` : s;
}

/**
 * Export names for a set of objects. A table or view is its name in camel
 * case, prefixed with its database when two databases share a name; a
 * database is its name with `Db` after it, so `analytics` the database and
 * `analytics` a table do not collide.
 */
export function exportNames(objects: readonly ImportedObject[]): string[] {
  const relations = objects.filter((o) => o.type !== CLICKHOUSE_ENTITY_TYPES.database);
  const count = new Map<string, number>();
  for (const o of relations) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  const used = new Set<string>();
  return objects.map((o) => {
    let base =
      o.type === CLICKHOUSE_ENTITY_TYPES.database
        ? `${camel(o.name)}Db`
        : (count.get(o.name) ?? 0) > 1 && o.database
          ? camel(`${o.database}_${o.name}`)
          : camel(o.name);
    if (JS_RESERVED.has(base)) base = `${base}Table`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  });
}

/** Split a file of statements on top-level `;`. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current: Token[] = [];
  const flush = () => {
    const stmt = current.map((t) => t.text).join("").trim();
    if (current.some((t) => !isTrivia(t))) out.push(stmt);
    current = [];
  };
  for (const t of tokenizeText(text, 0)) {
    if (t.kind === "punct" && t.text === ";") flush();
    else current.push(t);
  }
  flush();
  return out;
}

const statementType = (node: CreateNode): ClickHouseEntityType =>
  node.statement === "database"
    ? CLICKHOUSE_ENTITY_TYPES.database
    : node.statement === "table"
      ? CLICKHOUSE_ENTITY_TYPES.table
      : node.statement === "dictionary"
        ? CLICKHOUSE_ENTITY_TYPES.dictionary
        : node.statement === "function"
          ? CLICKHOUSE_ENTITY_TYPES.function
          : node.materialized
        ? CLICKHOUSE_ENTITY_TYPES.materializedView
        : CLICKHOUSE_ENTITY_TYPES.view;

function nameOf(tokens: Token[], span: Span): { database?: string; name: string } {
  const parts = tokens
    .slice(span.from, span.to)
    .filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  return parts.length >= 2 ? { database: parts[parts.length - 2], name: parts[parts.length - 1]! } : { name: parts[0] ?? "" };
}

/** Read a statement's kind and name. Throws the parser's error when it does not parse. */
export function describeStatement(ddl: string): ImportedObject {
  const tokens = tokenizeText(ddl, 0);
  const node = parseCreate(tokens);
  return { type: statementType(node), ...nameOf(tokens, node.name), ddl };
}

/**
 * Leave out what the server adds and the declaration would not say: settings
 * at the pinned server's default (`index_granularity = 8192`), and a view's
 * column list, which the server infers from the SELECT. A server re-adds both
 * on create, so the stripped statement creates the same object.
 */
export function stripServerDefaults(ddl: string): string {
  const tokens = tokenizeText(ddl, 0);
  let node: CreateNode;
  try {
    node = parseCreate(tokens);
  } catch {
    return ddl;
  }
  const edits: Array<{ span: Span; text: string }> = [];
  if ((node.statement === "table" || node.statement === "view") && node.settings && node.settingsClause) {
    const text = (s: Span) => tokens.slice(s.from, s.to).map((t) => t.text).join("").trim();
    const kept = node.settings.filter((s) => {
      const def = (MERGE_TREE_SETTINGS as Record<string, { default: string } | undefined>)[s.key];
      return !def || text(s.value).replace(/^'|'$/g, "") !== def.default;
    });
    if (kept.length !== node.settings.length) {
      edits.push({
        span: node.settingsClause,
        text: kept.length === 0 ? "" : `SETTINGS ${kept.map((s) => `${s.key} = ${text(s.value)}`).join(", ")}`,
      });
    }
  }
  if (node.statement === "view" && node.columnsSpan) edits.push({ span: node.columnsSpan, text: "" });
  if (edits.length === 0) return ddl;
  edits.sort((a, b) => b.span.from - a.span.from);
  const out = [...tokens];
  for (const e of edits) {
    out.splice(e.span.from, e.span.to - e.span.from, { kind: "ws", text: e.text, part: 0, start: 0, end: 0 });
  }
  return out
    .map((t) => t.text)
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .replace(/[ \t]+$/gm, "");
}

/** The IR for a set of objects. */
export function objectsToIR(objects: readonly ImportedObject[], warnings: string[] = []): TemplateIR {
  const names = exportNames(objects);
  const resources: ResourceIR[] = objects.map((o, i) => ({
    logicalId: names[i]!,
    type: o.type,
    properties: { ...(o.database ? { database: o.database } : {}), name: o.name, ddl: o.ddl },
  }));
  return { resources, parameters: [], ...(warnings.length ? { warnings } : {}) };
}
