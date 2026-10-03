/**
 * Spike (#3278): the dialect-neutral half of lexicons/sql/src/clickhouse/entities.ts,
 * as the shared core would hold it. Everything here exists today in the
 * ClickHouse file with the ClickHouse predicates and rules inlined; the
 * dialect is a parameter instead.
 *
 * - templateParts / unescapeTemplateDelimiters: the raw parts a tag reads (#3221)
 * - SqlTemplateError and interpolationLine: errors located on a template line
 * - splice(): plain strings spliced as SQL text, references kept as `ref` tokens
 * - text() / feed(): a span's rendered text, and which props a spliced value fed (#3212)
 * - makeEntity(): a Declarable with hidden lexicon fields, a `columns` map of
 *   AttrRefs, and an enumerable `dependsOn` core's graph walks
 * - lineage(): the top-level select list's output columns and their references
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant/attrref";
import { isTrivia, SqlSyntaxError, tokenize, tokenizeText, untokenize, type LexicalRules, type Token } from "./tokens";
import type { Span } from "./cursor";

export const SQL_LEXICON = "sql";

/** What a dialect supplies to the shared template machinery. */
export interface Dialect {
  name: string;
  lexical: LexicalRules;
  /** An entity of this dialect (anything an interpolation may reference as an object). */
  isObject(value: unknown): value is SqlObject;
  /** How a referenced object or column renders in the SQL. */
  renderReference(value: unknown): string;
  /** An identifier as it appears in a select list, unquoted and case-folded as the dialect does. */
  identValue(t: Token): string;
  /** The SQL a string-literal helper wraps a value in. */
  quoteLiteral(value: string): string;
}

export abstract class SqlObject implements Declarable {
  declare readonly [DECLARABLE_MARKER]: true;
  declare readonly lexicon: "sql";
  declare readonly entityType: string;
  declare readonly kind: "resource";
  declare readonly sqlName: string;
  declare readonly props: object;
  declare readonly dependsOn: readonly unknown[];
}

/** A spliced value meant as a string literal. Made by a dialect's `literal()`. */
export class SqlLiteral {
  constructor(readonly sql: string) {
    Object.freeze(this);
  }
}

export function templateParts(strings: TemplateStringsArray | readonly string[]): string[] {
  const raw = (strings as TemplateStringsArray).raw ?? strings;
  return raw.map(unescapeTemplateDelimiters);
}

export function unescapeTemplateDelimiters(part: string): string {
  return part.replace(/\\(`|\$\{)/g, "$1");
}

export function interpolationLine(parts: readonly string[], index: number): number {
  return parts.slice(0, index + 1).join("${}").split("\n").length;
}

export class SqlTemplateError extends Error {
  constructor(
    tag: string,
    message: string,
    readonly part: number,
    readonly offset: number,
  ) {
    super(`${tag}\`...\`: ${message}`);
    this.name = "SqlTemplateError";
  }
}

const hidden = (target: object, key: string | symbol, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });

export function makeEntity<T extends SqlObject>(
  proto: object,
  entityType: string,
  sqlName: string,
  props: object,
  columnNames: readonly string[] | undefined,
  dependsOn: unknown[],
): T {
  const entity = Object.create(proto) as T;
  hidden(entity, DECLARABLE_MARKER, true);
  hidden(entity, "lexicon", SQL_LEXICON);
  hidden(entity, "entityType", entityType);
  hidden(entity, "kind", "resource");
  hidden(entity, "props", props);
  hidden(entity, "sqlName", sqlName);
  if (columnNames) {
    const columns: Record<string, AttrRef> = {};
    for (const name of columnNames) columns[name] = new AttrRef(entity, name);
    hidden(entity, "columns", Object.freeze(columns));
  }
  Object.defineProperty(entity, "dependsOn", { value: dependsOn, enumerable: true });
  return entity;
}

/** A column reference of this dialect: an AttrRef whose parent is one of its objects. */
export function isColumnRefOf(d: Dialect, value: unknown): value is AttrRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<AttrRef>;
  if (typeof v.attribute !== "string" || typeof v.parent?.deref !== "function") return false;
  return d.isObject(v.parent.deref());
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? `an object (${Object.prototype.toString.call(value)})` : `a ${typeof value}`;
}

function spliceText(value: unknown): string | { error: string } {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : { error: `the number ${value} has no SQL form` };
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "NULL";
  if (value instanceof SqlLiteral) return value.sql;
  if (value === undefined) {
    return {
      error:
        "undefined. A column is referenced through `.columns` (`${users.columns.id}`, not `${users.id}`), and a column name that does not exist is undefined too",
    };
  }
  return { error: `${describe(value)}, which has no SQL form` };
}

export interface Ctx {
  d: Dialect;
  tokens: Token[];
  values: readonly unknown[];
  fed: Array<Set<string>>;
}

export function splice(d: Dialect, tag: string, parts: readonly string[], values: readonly unknown[]): Token[] {
  const out: Token[] = [];
  for (const t of tokenize(parts, d.lexical)) {
    if (t.kind !== "ref") {
      out.push(t);
      continue;
    }
    const value = values[t.part];
    if (d.isObject(value) || isColumnRefOf(d, value)) {
      out.push(t);
      continue;
    }
    const text = spliceText(value);
    if (typeof text !== "string") {
      throw new SqlTemplateError(tag, `the interpolation on template line ${interpolationLine(parts, t.part)} is ${text.error}`, t.part, parts[t.part]!.length);
    }
    for (const s of tokenizeText(text, t.part, d.lexical)) out.push({ ...s, splice: t.part });
  }
  return out;
}

export function feed(ctx: Ctx, span: Span | undefined, path: string): void {
  if (!span) return;
  for (let i = span.from; i < span.to; i++) {
    const s = ctx.tokens[i]!.splice;
    if (s !== undefined) ctx.fed[s]!.add(path);
  }
}

export function text(ctx: Ctx, span: Span | undefined, path?: string): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  if (path) feed(ctx, span, path);
  return untokenize(ctx.tokens.slice(span.from, span.to), (i) => ctx.d.renderReference(ctx.values[i])).trim();
}

/** A located template error from a parse failure. */
export function templateSyntaxError(tag: string, parts: readonly string[], err: SqlSyntaxError): SqlTemplateError {
  const where =
    err.token?.splice !== undefined
      ? `in the text interpolated on template line ${interpolationLine(parts, err.token.splice)}`
      : `on template line ${parts.slice(0, err.part).join("${}").split("\n").length + parts[err.part]!.slice(0, err.offset).split("\n").length - 1}`;
  return new SqlTemplateError(tag, `${err.message} (${where})`, err.part, err.offset);
}

export interface LineageEdge {
  output: string;
  expr: string;
  from: AttrRef[];
}

/**
 * Column lineage of the top-level select list, as ClickHouse computes it, with
 * three Postgres additions: an alias without AS (`count(*) n`), a qualified
 * reference (`u.${users.columns.id}`) naming its output after the column, and
 * `DISTINCT ON (...)` skipped.
 */
export function lineage(ctx: Ctx, select: Span): { edges: LineageEdge[]; reads: SqlObject[] } {
  const { d } = ctx;
  const sig: number[] = [];
  for (let i = select.from; i < select.to; i++) if (!isTrivia(ctx.tokens[i]!)) sig.push(i);
  const tok = (i: number) => ctx.tokens[i]!;
  const isKw = (i: number, w: string) => tok(i).kind === "ident" && tok(i).text.toUpperCase() === w;
  const isP = (i: number, c: string) => tok(i).kind === "punct" && tok(i).text === c;
  let depth = 0;
  let selectAt = -1;
  let fromAt = sig.length;
  const commas: number[] = [];
  for (let k = 0; k < sig.length; k++) {
    const t = tok(sig[k]!);
    if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
    else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
    else if (depth === 0 && selectAt < 0 && isKw(sig[k]!, "SELECT")) {
      selectAt = k;
      if (sig[k + 1] !== undefined && (isKw(sig[k + 1]!, "DISTINCT") || isKw(sig[k + 1]!, "ALL"))) {
        selectAt = k + 1;
        if (sig[k + 2] !== undefined && isKw(sig[k + 2]!, "ON") && isP(sig[k + 3]!, "(")) {
          let dd = 0;
          let j = k + 3;
          for (; j < sig.length; j++) {
            if (isP(sig[j]!, "(")) dd++;
            else if (isP(sig[j]!, ")") && --dd === 0) break;
          }
          selectAt = j;
          k = j;
        }
      }
    } else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && (isKw(sig[k]!, "FROM") || isKw(sig[k]!, "UNION") || isKw(sig[k]!, "WHERE"))) fromAt = k;
    else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && t.kind === "punct" && t.text === ",") commas.push(k);
  }
  const isName = (i: number) => tok(i).kind === "ident" || tok(i).kind === "qident";
  const edges: LineageEdge[] = [];
  if (selectAt >= 0) {
    const bounds = [selectAt, ...commas, fromAt];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const items = sig.slice(bounds[b]! + 1, bounds[b + 1]);
      if (items.length === 0) continue;
      let output: string | undefined;
      let exprItems = items;
      const last = items[items.length - 1]!;
      const before = items[items.length - 2];
      if (before !== undefined && isKw(before, "AS") && isName(last)) {
        output = d.identValue(tok(last));
        exprItems = items.slice(0, -2);
      } else if (
        items.length >= 2 &&
        isName(last) &&
        !["NULL", "TRUE", "FALSE", "END", "ASC", "DESC", "UNKNOWN"].includes(tok(last).text.toUpperCase()) &&
        before !== undefined &&
        !(tok(before).kind === "punct" && tok(before).text === ".") &&
        tok(before).kind !== "op"
      ) {
        output = d.identValue(tok(last));
        exprItems = items.slice(0, -1);
      } else {
        const lastT = tok(last);
        const plain = items.length === 1 || (items.length === 3 && isP(items[1]!, "."));
        if (plain && lastT.kind === "ref" && isColumnRefOf(d, ctx.values[lastT.part])) output = (ctx.values[lastT.part] as AttrRef).attribute;
        else if (plain && isName(last)) output = d.identValue(lastT);
      }
      const refs = exprItems.filter((i) => tok(i).kind === "ref").map((i) => tok(i).part);
      const exprSpan: Span = { from: exprItems[0]!, to: exprItems[exprItems.length - 1]! + 1, refs };
      edges.push({
        output: output ?? `?column?${b + 1}`,
        expr: text(ctx, exprSpan) ?? "",
        from: [...new Set(refs.map((i) => ctx.values[i]).filter((v): v is AttrRef => isColumnRefOf(d, v)))],
      });
    }
  }
  const reads = [...new Set(select.refs.map((i) => ctx.values[i]).filter((v): v is SqlObject => d.isObject(v)))];
  return { edges, reads };
}

export { SqlSyntaxError, untokenize };
