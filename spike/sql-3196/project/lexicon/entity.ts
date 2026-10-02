/**
 * Spike (#3196): turn a parsed CREATE statement plus its interpolated values
 * into one entity value, with references, and the column-level lineage of a
 * view.
 *
 * An interpolation is classified by its VALUE, not by where it sits: a table
 * or view entity is a table reference, a column reference is a column
 * reference. Position only decides how it renders back into DDL text.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant/attrref";
import { isTrivia, tokenize, untokenize, type Token } from "./tokens";
import { parseCreate, type ColumnNode, type CreateNode, type Span } from "./parser";

export const LEXICON = "sql";
export const TABLE_TYPE = "ClickHouse::Table";
export const VIEW_TYPE = "ClickHouse::View";

/** A reference to one column, `${events.user_id}`. An AttrRef, so core's dependency graph sees it. */
export type ColumnRef = AttrRef;

/** Names a column cannot be reached by directly, because a Declarable already owns them. */
const RESERVED = new Set([
  "lexicon", "entityType", "kind", "props", "attributes", "columns", "sqlName",
  "toJSON", "constructor", "then",
]);

export interface ColumnValue {
  name: string;
  type?: string;
  nullable?: boolean;
  default?: { kind: string; expr?: string };
  codec?: string;
  ttl?: string;
  comment?: string;
}

export interface LineageEdge {
  /** Output column of the view. */
  output: string;
  /** Columns it reads, as references. */
  from: ColumnRef[];
  /** The expression text, rendered. */
  expr: string;
}

export interface SqlEntity extends Declarable {
  readonly sqlName: string;
  readonly columns: Readonly<Record<string, ColumnRef>>;
}

const isColumnRef = (v: unknown): v is ColumnRef =>
  v instanceof AttrRef || (typeof v === "object" && v !== null && "attribute" in v && "parent" in v);
const isSqlEntity = (v: unknown): v is SqlEntity =>
  typeof v === "object" && v !== null && (v as Declarable).lexicon === LEXICON && "sqlName" in v;

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + name.replace(/`/g, "``") + "`";
}

/** Render one interpolated value into DDL text. */
function renderValue(v: unknown): string {
  if (isSqlEntity(v)) return v.sqlName;
  if (isColumnRef(v)) return quoteIdent(v.attribute);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") {
    // A plain string interpolation (a composite's `${props.ttl}`) is spliced as SQL text.
    return v;
  }
  throw new TypeError(`cannot interpolate ${Object.prototype.toString.call(v)} into ClickHouse DDL`);
}

interface Ctx {
  tokens: Token[];
  values: readonly unknown[];
}

/** A span's text with every interpolation rendered, trivia kept, trimmed at both ends. */
function text(ctx: Ctx, span: Span | undefined): string | undefined {
  if (!span) return undefined;
  return untokenize(ctx.tokens.slice(span.from, span.to), (i) => renderValue(ctx.values[i])).trim();
}

/** The interpolated values a span holds that are column references. */
function columnRefs(ctx: Ctx, span: Span): ColumnRef[] {
  return span.refs.map((i) => ctx.values[i]).filter(isColumnRef);
}

function columnValue(ctx: Ctx, c: ColumnNode): ColumnValue {
  const strip = (s?: string) => (s && s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
  return {
    name: c.name,
    type: text(ctx, c.type),
    nullable: c.nullable,
    default: c.default ? { kind: c.default.kind, expr: text(ctx, c.default.expr) } : undefined,
    codec: text(ctx, c.codec),
    ttl: text(ctx, c.ttl),
    comment: strip(text(ctx, c.comment)),
  };
}

/**
 * Column-level lineage of a view's SELECT: one edge per item of the top-level
 * select list. Only the select list is split; FROM, WHERE and GROUP BY stay
 * text, and their column references land in `reads`.
 */
function lineage(ctx: Ctx, select: Span): { edges: LineageEdge[]; reads: ColumnRef[]; tables: SqlEntity[] } {
  const sig: number[] = [];
  for (let i = select.from; i < select.to; i++) if (!isTrivia(ctx.tokens[i])) sig.push(i);
  const isKw = (i: number, w: string) => ctx.tokens[i].kind === "ident" && ctx.tokens[i].text.toUpperCase() === w;
  let depth = 0;
  let selectAt = -1;
  let fromAt = sig.length;
  const commas: number[] = [];
  for (let k = 0; k < sig.length; k++) {
    const t = ctx.tokens[sig[k]];
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (depth === 0 && selectAt < 0 && isKw(sig[k], "SELECT")) selectAt = k;
    else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && isKw(sig[k], "FROM")) fromAt = k;
    else if (depth === 0 && selectAt >= 0 && fromAt === sig.length && t.kind === "punct" && t.text === ",") commas.push(k);
  }
  const edges: LineageEdge[] = [];
  if (selectAt >= 0) {
    const bounds = [selectAt, ...commas, fromAt];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const items = sig.slice(bounds[b] + 1, bounds[b + 1]);
      if (items.length === 0) continue;
      const span: Span = {
        from: items[0],
        to: items[items.length - 1] + 1,
        refs: items.filter((i) => ctx.tokens[i].kind === "ref").map((i) => ctx.tokens[i].part),
      };
      // `expr AS alias`, a bare column reference, or a bare identifier name the output.
      let output: string | undefined;
      const asAt = items.findIndex((i) => isKw(i, "AS"));
      let exprItems = items;
      if (asAt >= 0) {
        output = ctx.tokens[items[asAt + 1]]?.text.replace(/^`|`$/g, "");
        exprItems = items.slice(0, asAt);
      } else if (items.length === 1) {
        const t = ctx.tokens[items[0]];
        if (t.kind === "ref" && isColumnRef(ctx.values[t.part])) output = (ctx.values[t.part] as ColumnRef).attribute;
        else if (t.kind === "ident" || t.kind === "qident") output = t.text.replace(/^`|`$/g, "");
      }
      const exprSpan: Span = { ...span, to: exprItems[exprItems.length - 1] + 1 };
      edges.push({ output: output ?? `_${b}`, from: columnRefs(ctx, span), expr: text(ctx, exprSpan)! });
    }
  }
  const all = select.refs.map((i) => ctx.values[i]);
  return {
    edges,
    reads: all.filter(isColumnRef),
    tables: [...new Set(all.filter(isSqlEntity))],
  };
}

/** Build the Declarable. `refs` is enumerable so core's dependency graph walks it. */
function makeEntity(entityType: string, sqlName: string, props: Record<string, unknown>, columnNames: string[], refs: unknown[]): SqlEntity {
  const entity = {} as Record<string | symbol, unknown>;
  Object.defineProperty(entity, DECLARABLE_MARKER, { value: true, enumerable: false });
  Object.defineProperty(entity, "lexicon", { value: LEXICON, enumerable: false });
  Object.defineProperty(entity, "entityType", { value: entityType, enumerable: false });
  Object.defineProperty(entity, "kind", { value: "resource", enumerable: false });
  Object.defineProperty(entity, "props", { value: props, enumerable: false });
  Object.defineProperty(entity, "sqlName", { value: sqlName, enumerable: false });
  const columns: Record<string, ColumnRef> = {};
  for (const name of columnNames) {
    const ref = new AttrRef(entity, name);
    columns[name] = ref;
    // `${events.user_id}` reaches the column directly unless a Declarable field owns the name.
    if (!RESERVED.has(name)) Object.defineProperty(entity, name, { value: ref, enumerable: true });
  }
  Object.defineProperty(entity, "columns", { value: Object.freeze(columns), enumerable: false });
  Object.defineProperty(entity, "dependsOn", { value: refs, enumerable: true });
  return entity as unknown as SqlEntity;
}

/** The SQL a template holds, raw: what the author wrote, backslashes included. */
function rawParts(strings: TemplateStringsArray | readonly string[]): readonly string[] {
  return (strings as TemplateStringsArray).raw ?? strings;
}

function build(strings: TemplateStringsArray | readonly string[], values: unknown[], expect: "table" | "view"): SqlEntity {
  const parts = rawParts(strings);
  const tokens = tokenize(parts);
  const node: CreateNode = parseCreate(tokens);
  const ctx: Ctx = { tokens, values };
  if (node.statement !== expect) {
    throw new SyntaxError(`${expect}\`…\` holds a CREATE ${node.statement === "table" ? "TABLE" : "VIEW"}`);
  }
  const [database, sqlName] = (() => {
    const n = text(ctx, node.name)!.split(".");
    return n.length === 2 ? [n[0], n[1]] : [undefined, n[0]];
  })();
  const ddl = text(ctx, { from: 0, to: tokens.length, refs: [] })!;
  const storage = {
    engine: node.engine ? { name: node.engine.name, args: node.engine.args?.map((a) => text(ctx, a)!) } : undefined,
    orderBy: text(ctx, node.orderBy),
    primaryKey: text(ctx, node.primaryKey),
    partitionBy: text(ctx, node.partitionBy),
    sampleBy: text(ctx, node.sampleBy),
    ttl: text(ctx, node.ttl),
    settings: node.settings ? Object.fromEntries(node.settings.map((s) => [s.key, text(ctx, s.value)])) : undefined,
  };
  const source = { strings: [...parts] };

  if (node.statement === "table") {
    const columns = node.columns.map((c) => columnValue(ctx, c));
    const props = {
      name: sqlName,
      database,
      onCluster: text(ctx, node.onCluster),
      columns,
      indexes: node.indexes.map((i) => ({ name: i.name, expr: text(ctx, i.expr), type: text(ctx, i.type), granularity: text(ctx, i.granularity) })),
      projections: node.projections.map((p) => ({ name: p.name, select: text(ctx, p.body) })),
      constraints: node.constraints.map((c) => ({ name: c.name, kind: c.kind, expr: text(ctx, c.expr) })),
      ...storage,
      comment: text(ctx, node.comment)?.replace(/^'|'$/g, ""),
      ddl,
      source,
    };
    const refs = values.filter((v) => isSqlEntity(v) || isColumnRef(v));
    return makeEntity(TABLE_TYPE, database ? `${database}.${sqlName}` : sqlName, props, columns.map((c) => c.name), refs);
  }

  const lin = lineage(ctx, node.select);
  const target = node.to ? values[node.to.refs[0]] : undefined;
  const props = {
    name: sqlName,
    database,
    viewKind: node.refresh ? "refreshable" : node.materialized ? "materialized" : "view",
    onCluster: text(ctx, node.onCluster),
    refresh: text(ctx, node.refresh),
    to: node.to ? (isSqlEntity(target) ? target : text(ctx, node.to)) : undefined,
    columns: node.columns.map((c) => columnValue(ctx, c)),
    ...storage,
    populate: node.populate || undefined,
    select: text(ctx, node.select),
    reads: lin.tables,
    lineage: lin.edges,
    columnReads: lin.reads,
    comment: text(ctx, node.comment)?.replace(/^'|'$/g, ""),
    ddl,
    source,
  };
  const outputs = node.columns.length > 0 ? node.columns.map((c) => c.name) : lin.edges.map((e) => e.output);
  const refs = values.filter((v) => isSqlEntity(v) || isColumnRef(v));
  return makeEntity(VIEW_TYPE, database ? `${database}.${sqlName}` : sqlName, props, outputs, refs);
}

/** `table\`CREATE TABLE …\`` — one ClickHouse table, parsed at fold time. */
export function table(strings: TemplateStringsArray, ...values: unknown[]): SqlEntity & Record<string, ColumnRef> {
  return build(strings, values, "table") as SqlEntity & Record<string, ColumnRef>;
}

/** `view\`CREATE [MATERIALIZED] VIEW …\`` — one view, its reads and its column lineage. */
export function view(strings: TemplateStringsArray, ...values: unknown[]): SqlEntity & Record<string, ColumnRef> {
  return build(strings, values, "view") as SqlEntity & Record<string, ColumnRef>;
}
