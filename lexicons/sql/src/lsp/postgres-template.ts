/**
 * Finding where the cursor is inside a Postgres template, and what the SQL
 * before it says should come next. Shares the template finder with the lint
 * rules, so the editor and `chant lint` agree on which tags are Postgres's.
 */

import * as ts from "typescript";
import { isTrivia, tokenize, type Token } from "../postgres/tokens";
import { parseStatements, type Span } from "../postgres/parser";
import type { PostgresTag } from "../postgres/entities";
import { POSTGRES_TEMPLATE_SOURCES, findPostgresTemplates, type PostgresFoundTemplate } from "../lint/rules/postgres-templates";
import { locateIn, type Located as CoreLocated } from "../core/find-templates";

export type PostgresLocated = CoreLocated<PostgresTag>;

/** The Postgres template the source offset `at` is inside, and where in it. */
export function locatePostgres(content: string, at: number, fileName = "file.ts"): PostgresLocated | undefined {
  return locateIn(content, at, POSTGRES_TEMPLATE_SOURCES, fileName);
}

/** Significant tokens of the template up to `offset` in `part`; undefined when the text before it does not tokenize. */
export function postgresTokensBefore(found: PostgresFoundTemplate, part: number, offset: number): Token[] | undefined {
  try {
    const parts = [...found.parts.slice(0, part), found.parts[part]!.slice(0, offset)];
    return tokenize(parts).filter((t) => !isTrivia(t));
  } catch {
    return undefined;
  }
}

export type PostgresExpect = "index-method" | "table-method" | "type" | "storage-parameter" | "extension" | "function" | "keyword";

const upper = (t: Token | undefined): string => (t?.kind === "ident" ? t.text.toUpperCase() : "");
const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === "punct" && t.text === text;

const EXPRESSION_AFTER = new Set(["DEFAULT", "WHERE", "SELECT", "AND", "OR", "WHEN", "THEN", "ELSE", "HAVING", "BY", "ON", "NOT", "CHECK", "AS", "USING"]);
const EXPRESSION_CONTEXT = new Set(["SELECT", "DEFAULT", "CHECK", "WHERE", "GENERATED", "HAVING"]);
const NOT_A_COLUMN = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "EXCLUDE", "LIKE"]);

/** What the SQL before the cursor expects; undefined where a name of the user's own goes. */
export function postgresExpectAfter(sig: readonly Token[], tag: PostgresTag): PostgresExpect | undefined {
  const last = sig[sig.length - 1];
  if (!last) return undefined;
  const prev = sig[sig.length - 2];

  if (tag === "extension" && (upper(last) === "EXTENSION" || upper(last) === "EXISTS")) return "extension";
  if (upper(last) === "USING") {
    if (tag === "index" || upper(prev) === "EXCLUDE" || (prev === undefined ? false : sig.some((t) => upper(t) === "EXCLUDE"))) return "index-method";
    return tag === "table" || tag === "view" ? "table-method" : undefined;
  }
  if (last.kind === "op" && last.text === "::") return "type";
  if ((tag === "domain" || tag === "sequence") && upper(last) === "AS") return "type";

  const open: number[] = [];
  sig.forEach((t, i) => {
    if (isPunct(t, "(")) open.push(i);
    else if (isPunct(t, ")")) open.pop();
  });
  const opener = open[open.length - 1];
  const before = opener === undefined ? undefined : sig[opener - 1];
  const afterOpenOrComma = isPunct(last, "(") || isPunct(last, ",");

  if (afterOpenOrComma && opener !== undefined && upper(before) === "WITH") return "storage-parameter";

  // A table's column list: a name goes first, then a type.
  const columnList = tag === "table" && open.length === 1 && opener === sig.findIndex((t) => isPunct(t, "("));
  if (columnList) {
    if (afterOpenOrComma) return undefined;
    if ((last.kind === "ident" || last.kind === "qident") && (isPunct(prev, "(") || isPunct(prev, ",")) && !NOT_A_COLUMN.has(upper(last))) return "type";
  }

  if (EXPRESSION_AFTER.has(upper(last))) return "function";
  if ((afterOpenOrComma || last.kind === "op") && sig.some((t) => EXPRESSION_CONTEXT.has(upper(t)))) return "function";
  if (afterOpenOrComma && !columnList) return undefined;
  if (last.kind === "ident" || last.kind === "qident" || isPunct(last, ")")) return "keyword";
  return undefined;
}

/** The storage-parameter target a template's `WITH (...)` is for. */
export function storageTarget(sig: readonly Token[], tag: PostgresTag): string {
  if (tag === "index") {
    const i = sig.findIndex((t) => upper(t) === "USING");
    const method = i >= 0 && sig[i + 1]?.kind === "ident" ? sig[i + 1]!.text.toLowerCase() : "btree";
    return `index:${method}`;
  }
  if (tag === "view") return sig.some((t) => upper(t) === "MATERIALIZED") ? "materialized view" : "view";
  return "table";
}

// ── Declarations in a file ─────────────────────────────────────────────

export interface PostgresDeclared {
  /** The const the template is bound to. */
  name: string;
  tag: PostgresTag;
  /** The kind, as a reader says it: `table`, `materialized view`, `enum type`. */
  kind: string;
  /** The name the DDL gives the object, interpolations written back as `${...}`. */
  sqlName: string;
  columns: Array<{ name: string; type?: string }>;
}

function spanText(found: PostgresFoundTemplate, tokens: Token[], span: Span | undefined, source: ts.SourceFile): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  return tokens
    .slice(span.from, span.to)
    .map((t) => (t.kind === "ref" ? `\${${found.expressions[t.part]?.getText(source) ?? "..."}}` : t.text))
    .join("")
    .trim();
}

/** Every `const x = table\`...\`` (and the other tags) in the content that parses, by const name. */
export function postgresDeclarations(content: string, fileName = "file.ts"): PostgresDeclared[] {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const out: PostgresDeclared[] = [];
  for (const found of findPostgresTemplates(source)) {
    const decl = found.node.parent;
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) continue;
    try {
      const tokens = tokenize(found.parts);
      const node = parseStatements(tokens)[0];
      if (!node) continue;
      const text = (span: Span | undefined) => spanText(found, tokens, span, source);
      let sqlName: string | undefined;
      let kind: string = found.tag;
      let columns: PostgresDeclared["columns"] = [];
      switch (node.statement) {
        case "table":
          sqlName = text(node.name.span);
          columns = node.columns.map((c) => ({ name: c.name || text(c.nameSpan) || "", ...(text(c.type) ? { type: text(c.type)! } : {}) }));
          break;
        case "view":
          sqlName = text(node.name.span);
          kind = node.materialized ? "materialized view" : "view";
          columns = node.columnNames.map((c) => ({ name: c.name || text(c.span) || "" }));
          break;
        case "enum":
          sqlName = text(node.name.span);
          kind = "enum type";
          break;
        case "index":
          sqlName = node.name ? text(node.name.span) : undefined;
          break;
        case "schema":
          sqlName = node.name ? text(node.name.span) : undefined;
          break;
        case "sequence":
        case "domain":
        case "extension":
          sqlName = text(node.name.span);
          break;
        case "function":
        case "procedure":
        case "trigger":
          sqlName = text(node.name.span);
          kind = node.statement;
          break;
        default:
          continue;
      }
      out.push({ name: decl.name.text, tag: found.tag, kind, sqlName: sqlName ?? decl.name.text, columns });
    } catch {
      // A template that does not parse is SQLPG001's to report; it has nothing to offer.
    }
  }
  return out;
}
