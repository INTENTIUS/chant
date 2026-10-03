/**
 * What a tag does with its interpolations, in every dialect (chant #3196,
 * #3212): splice plain values into the token list as SQL text while
 * references stay `ref` tokens, render a span with its references written as
 * names, record which props each spliced value fed, locate a parse error on
 * its template line, and read column lineage off a view's select list.
 *
 * The dialect supplies its tokenizer rules, which values are its objects and
 * column references, how a reference renders, and how a select-list name
 * reads ({@link TemplateDialect}).
 */

import type { AttrRef } from "@intentius/chant/attrref";
import { isTrivia, SqlSyntaxError, tokenize, tokenizeText, untokenize, type LexicalRules, type Token } from "./tokens";
import type { Span } from "./cursor";
import type { LineageEdge } from "./references";
import type { SqlObject } from "./entity";
import { interpolationLine, spliceText, SqlTemplateError } from "./template";

/** What a dialect supplies to the shared template machinery. */
export interface TemplateDialect {
  lexical: LexicalRules;
  /** An entity of this dialect: an interpolation that references an object. */
  isObject(value: unknown): value is SqlObject;
  /** A column reference to one of this dialect's objects. */
  isColumnRef(value: unknown): value is AttrRef;
  /** How a referenced object or column renders in the SQL. */
  renderReference(value: unknown): string;
  /** A name token's value in a select list (identifier quotes off). */
  identValue(text: string): string;
  /** The output name of the `n`th (1-based) select-list item that has none. */
  unnamedOutput(n: number): string;
}

/** A template being built: its tokens, the interpolated values, and what each spliced value fed. */
export interface TemplateCtx {
  d: TemplateDialect;
  tokens: Token[];
  values: readonly unknown[];
  /**
   * Per interpolation, the props paths its spliced text landed in (#3212).
   * Only spliced text counts: an interpolated entity or column is a reference
   * to a sibling, not a value the author typed into this field.
   */
  fed: Array<Set<string>>;
}

/** Record that the spliced text inside `span` fed `path`. */
export function feed(ctx: TemplateCtx, span: Span | undefined, path: string): void {
  if (!span) return;
  for (let i = span.from; i < span.to; i++) {
    const splice = ctx.tokens[i]!.splice;
    if (splice !== undefined) ctx.fed[splice]!.add(path);
  }
}

/**
 * Splice every interpolation that is not a reference into the token list as
 * SQL text. References stay `ref` tokens for the parser and the entity to see.
 */
export function splice(d: TemplateDialect, tag: string, parts: readonly string[], values: readonly unknown[]): Token[] {
  const out: Token[] = [];
  for (const t of tokenize(parts, d.lexical)) {
    if (t.kind !== "ref") {
      out.push(t);
      continue;
    }
    const value = values[t.part];
    if (d.isObject(value) || d.isColumnRef(value)) {
      out.push(t);
      continue;
    }
    const text = spliceText(value);
    if (typeof text !== "string") {
      throw new SqlTemplateError(
        tag,
        `the interpolation on template line ${interpolationLine(parts, t.part)} is ${text.error}`,
        t.part,
        parts[t.part]!.length,
      );
    }
    try {
      for (const s of tokenizeText(text, t.part, d.lexical)) out.push({ ...s, splice: t.part });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SqlTemplateError(
        tag,
        `the text interpolated on template line ${interpolationLine(parts, t.part)} does not tokenize: ${message}`,
        t.part,
        parts[t.part]!.length,
      );
    }
  }
  return out;
}

/** A span's text, interpolations rendered, trimmed. With `path`, the span's spliced text is recorded as feeding it. */
export function spanText(ctx: TemplateCtx, span: Span | undefined, path?: string): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  if (path) feed(ctx, span, path);
  return untokenize(ctx.tokens.slice(span.from, span.to), (i) => ctx.d.renderReference(ctx.values[i])).trim();
}

/** A parse error as the tag reports it: on the template line, or in the interpolated text it came from. */
export function templateSyntaxError(tag: string, parts: readonly string[], err: SqlSyntaxError): SqlTemplateError {
  const where =
    err.token?.splice !== undefined
      ? `in the text interpolated on template line ${interpolationLine(parts, err.token.splice)}`
      : `on template line ${parts.slice(0, err.part).join("${}").split("\n").length + parts[err.part]!.slice(0, err.offset).split("\n").length - 1}`;
  return new SqlTemplateError(tag, `${err.message} (${where})`, err.part, err.offset);
}

/**
 * Column-level lineage of a view's SELECT: one edge per item of the top-level
 * select list. FROM, WHERE and GROUP BY stay text; the objects they
 * interpolate land in `reads`. A column written by name inside the SQL is not
 * lineage: only references are (#3047, "no parsing of SQL for names").
 */
export function lineage<O extends SqlObject>(ctx: TemplateCtx, select: Span): { edges: LineageEdge[]; reads: O[] } {
  const { d } = ctx;
  const sig: number[] = [];
  for (let i = select.from; i < select.to; i++) if (!isTrivia(ctx.tokens[i]!)) sig.push(i);
  const tok = (i: number) => ctx.tokens[i]!;
  const isKw = (i: number, w: string) => tok(i).kind === "ident" && tok(i).text.toUpperCase() === w;
  let depth = 0;
  let selectAt = -1;
  let fromAt = sig.length;
  const commas: number[] = [];
  for (let k = 0; k < sig.length; k++) {
    const t = tok(sig[k]!);
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (depth === 0 && selectAt < 0 && isKw(sig[k]!, "SELECT")) {
      selectAt = k;
      if (sig[k + 1] !== undefined && isKw(sig[k + 1]!, "DISTINCT")) selectAt = k + 1;
    } else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && isKw(sig[k]!, "FROM")) fromAt = k;
    else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && t.kind === "punct" && t.text === ",") commas.push(k);
  }
  const edges: LineageEdge[] = [];
  if (selectAt >= 0) {
    const bounds = [selectAt, ...commas, fromAt];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const items = sig.slice(bounds[b]! + 1, bounds[b + 1]);
      if (items.length === 0) continue;
      let output: string | undefined;
      let exprItems = items;
      const asAt = items.findIndex((i) => isKw(i, "AS"));
      if (asAt >= 0 && asAt === items.length - 2) {
        output = d.identValue(tok(items[asAt + 1]!).text);
        exprItems = items.slice(0, asAt);
      } else if (items.length === 1) {
        const t = tok(items[0]!);
        if (t.kind === "ref" && d.isColumnRef(ctx.values[t.part])) output = (ctx.values[t.part] as AttrRef).attribute;
        else if (t.kind === "ident" || t.kind === "qident") output = d.identValue(t.text);
      } else if (items.length === 3 && tok(items[1]!).text === "." && (tok(items[2]!).kind === "ident" || tok(items[2]!).kind === "qident")) {
        output = d.identValue(tok(items[2]!).text);
      }
      const refs = exprItems.filter((i) => tok(i).kind === "ref").map((i) => tok(i).part);
      const exprSpan: Span = { from: exprItems[0]!, to: exprItems[exprItems.length - 1]! + 1, refs };
      edges.push({
        output: output ?? d.unnamedOutput(b + 1),
        expr: spanText(ctx, exprSpan) ?? "",
        from: [...new Set(refs.map((i) => ctx.values[i]).filter((v): v is AttrRef => d.isColumnRef(v)))],
      });
    }
  }
  const reads = [...new Set(select.refs.map((i) => ctx.values[i]).filter((v): v is O => d.isObject(v)))];
  return { edges, reads };
}

