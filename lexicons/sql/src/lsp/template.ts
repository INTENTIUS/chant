/**
 * Finding where the cursor is inside a `database`, `table` or `view` template,
 * and what the SQL before it says should come next. Shares the template finder
 * with the lint rules, so the editor and `chant lint` agree on what a template
 * is and which module's tags count.
 */

import * as ts from "typescript";
import { isTrivia, tokenize, type Token } from "../clickhouse/tokens";
import { parseCreate, type Span } from "../clickhouse/parser";
import { findTemplates, type FoundTemplate, type SqlTag } from "../lint/rules/templates";

export function offsetAt(content: string, pos: { line: number; character: number }): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return Math.min(offset + pos.character, content.length);
}

export interface Located {
  source: ts.SourceFile;
  found: FoundTemplate;
  /** The template part the cursor is in, or -1 when it is inside an interpolation's expression. */
  part: number;
  /** Offset in that part. */
  offset: number;
  /** The interpolation the cursor is in, when part is -1. */
  expression: number;
  /** Absolute source offset. */
  at: number;
}

export function locate(content: string, at: number, fileName = "file.ts"): Located | undefined {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  for (const found of findTemplates(source)) {
    const start = found.node.template.getStart(source);
    const end = found.node.template.getEnd();
    if (at <= start || at >= end) continue;
    for (let i = 0; i < found.parts.length; i++) {
      const from = found.starts[i]!;
      if (at >= from && at <= from + found.parts[i]!.length) {
        return { source, found, part: i, offset: at - from, expression: -1, at };
      }
    }
    const expression = found.expressions.findIndex((e) => at >= e.getStart(source) && at <= e.getEnd());
    return { source, found, part: -1, offset: 0, expression, at };
  }
  return undefined;
}

const WORD = /[A-Za-z0-9_]/;

/** The identifier characters around an offset in a part. */
export function wordAround(text: string, offset: number): { start: number; end: number } {
  let start = offset;
  while (start > 0 && WORD.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && WORD.test(text[end]!)) end++;
  return { start, end };
}

/** Significant tokens of the template up to `offset` in `part`; undefined when the text before it does not tokenize. */
export function tokensBefore(found: FoundTemplate, part: number, offset: number): Token[] | undefined {
  try {
    const parts = [...found.parts.slice(0, part), found.parts[part]!.slice(0, offset)];
    return tokenize(parts).filter((t) => !isTrivia(t));
  } catch {
    return undefined;
  }
}

/** What the SQL before the cursor expects. */
export type Expect =
  | "engine"
  | "type"
  | "codec"
  | "index-type"
  | "merge-tree-setting"
  | "query-setting"
  | "function";

const upper = (t: Token | undefined): string => (t?.kind === "ident" ? t.text.toUpperCase() : "");
const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === "punct" && t.text === text;

/** Words that end a SETTINGS list, or start something that is not one. */
const CLAUSE = new Set([
  "ENGINE", "ORDER", "PARTITION", "PRIMARY", "SAMPLE", "TTL", "AS", "SELECT", "COMMENT", "FROM", "WHERE", "GROUP",
  "HAVING", "LIMIT", "UNION", "TO", "POPULATE", "REFRESH", "WITH",
]);
/** Words after which an expression is written. */
const EXPRESSION_AFTER = new Set(["DEFAULT", "MATERIALIZED", "ALIAS", "TTL", "BY", "CHECK", "ASSUME", "SELECT", "WHERE", "HAVING", "ON", "AND", "OR", "WHEN", "THEN", "ELSE"]);
const TYPE_WRAPPERS = new Set(["NULLABLE", "ARRAY", "LOWCARDINALITY", "MAP", "TUPLE", "NESTED"]);
const NOT_A_COLUMN = new Set(["INDEX", "PROJECTION", "CONSTRAINT", "PRIMARY"]);

export function expectAfter(sig: readonly Token[], tag: SqlTag): Expect | undefined {
  const last = sig[sig.length - 1];
  if (!last) return undefined;
  const prev = sig[sig.length - 2];
  if (upper(last) === "ENGINE" || (isPunct(last, "=") && upper(prev) === "ENGINE")) return "engine";
  if (upper(last) === "TYPE") return "index-type";

  // The innermost open parenthesis, and the word before it.
  const open: number[] = [];
  sig.forEach((t, i) => {
    if (isPunct(t, "(")) open.push(i);
    else if (isPunct(t, ")")) open.pop();
  });
  const opener = open[open.length - 1];
  const fn = opener === undefined ? undefined : sig[opener - 1];
  const afterOpenOrComma = isPunct(last, "(") || isPunct(last, ",");

  if (afterOpenOrComma && opener !== undefined && upper(fn) === "CODEC") return "codec";
  if (isPunct(last, "(") && TYPE_WRAPPERS.has(upper(fn))) return "type";

  // A column's type: `(name |` in the column list, which is the first parenthesis of a table or view.
  if (tag !== "database" && open.length === 1 && (last.kind === "ident" || last.kind === "qident")) {
    const inColumnList = !sig.some((t) => upper(t) === "ENGINE" || upper(t) === "AS") && opener === firstParen(sig);
    if (inColumnList && (isPunct(prev, "(") || isPunct(prev, ",")) && !NOT_A_COLUMN.has(upper(last))) return "type";
  }

  // SETTINGS name = value, name = value: a name goes first, or after a comma.
  if (tag !== "database") {
    let depth = 0;
    for (let i = sig.length - 1; i >= 0; i--) {
      const t = sig[i]!;
      if (isPunct(t, ")")) depth++;
      else if (isPunct(t, "(")) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0) {
        const w = upper(t);
        if (w === "SETTINGS") {
          if (i === sig.length - 1 || isPunct(last, ",")) {
            return sig.slice(0, i).some((x) => upper(x) === "SELECT") ? "query-setting" : "merge-tree-setting";
          }
          break;
        }
        if (CLAUSE.has(w)) break;
      }
    }
  }

  if (EXPRESSION_AFTER.has(upper(last))) return "function";
  if (sig.some((t) => upper(t) === "SELECT") && (afterOpenOrComma || last.kind === "op")) return "function";
  return undefined;
}

function firstParen(sig: readonly Token[]): number {
  return sig.findIndex((t) => isPunct(t, "("));
}

// ── Declarations in a file ─────────────────────────────────────────────

export interface Declared {
  /** The const the template is bound to. */
  name: string;
  tag: SqlTag;
  /** The name the DDL gives the object, interpolations written back as `${...}`. */
  sqlName: string;
  materialized: boolean;
  columns: Array<{ name: string; type?: string }>;
  engine?: string;
}

function spanText(found: FoundTemplate, tokens: Token[], span: Span | undefined, source: ts.SourceFile): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  return tokens
    .slice(span.from, span.to)
    .map((t) => (t.kind === "ref" ? `\${${found.expressions[t.part]?.getText(source) ?? "..."}}` : t.text))
    .join("")
    .trim();
}

/** Every `const x = table\`...\`` in the content that parses, by const name. */
export function declarations(content: string, fileName = "file.ts"): Declared[] {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const out: Declared[] = [];
  for (const found of findTemplates(source)) {
    const decl = found.node.parent;
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) continue;
    try {
      const tokens = tokenize(found.parts);
      const node = parseCreate(tokens);
      const columns =
        node.statement === "database"
          ? []
          : node.columns.map((c) => ({
              name: c.name || spanText(found, tokens, c.nameSpan, source) || "",
              ...(spanText(found, tokens, c.type, source) ? { type: spanText(found, tokens, c.type, source)! } : {}),
            }));
      const engine = node.engine?.name || spanText(found, tokens, node.engine?.nameSpan, source);
      out.push({
        name: decl.name.text,
        tag: found.tag,
        sqlName: spanText(found, tokens, node.name, source) ?? decl.name.text,
        materialized: node.statement === "view" && node.materialized,
        columns,
        ...(engine ? { engine } : {}),
      });
    } catch {
      // A template that does not parse is SQLCH001's to report; it has no columns to offer.
    }
  }
  return out;
}
