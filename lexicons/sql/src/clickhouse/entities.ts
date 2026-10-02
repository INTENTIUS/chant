/**
 * The ClickHouse entities: `database`, `table` and `view` tagged templates that
 * parse their DDL at fold time into one Declarable each (chant #3196, #3197).
 *
 * ```ts
 * import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";
 *
 * export const events = table`
 *   CREATE TABLE events (user_id UUID, kind LowCardinality(String), ts DateTime)
 *   ENGINE = MergeTree ORDER BY (user_id, ts)`;
 *
 * export const activeUsers = view`
 *   CREATE MATERIALIZED VIEW active_users
 *   ENGINE = AggregatingMergeTree ORDER BY ${events.columns.user_id} AS
 *   SELECT ${events.columns.user_id}, count() AS n FROM ${events} GROUP BY ${events.columns.user_id}`;
 * ```
 *
 * The export name is the object's identity in chant; the name in the SQL is the
 * object's name in the database.
 *
 * What an interpolation means is decided by its value:
 *
 * - a `table`, `view` or `database` entity is a reference to that object, and
 *   renders as its (database-qualified) name;
 * - `entity.columns.<name>` is a reference to one column, and renders as the
 *   column's name;
 * - a string is SQL text, spliced into the statement before it is parsed, so a
 *   composite can supply a name, a type, an engine or an expression;
 * - a number or bigint is a numeric literal, a boolean `true`/`false`, `null`
 *   is `NULL`;
 * - `literal(value)` is a quoted, escaped string literal, for the case where a
 *   string is meant as a value (`DEFAULT ${literal(plan)}`).
 *
 * Anything else, `undefined` included, is refused with the position it was
 * interpolated at. `${events.user_id}` is `undefined` (columns are reached
 * through `.columns`), and the refusal says so.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant/attrref";
import { isTrivia, SqlSyntaxError, tokenize, tokenizeText, untokenize, type Token } from "./tokens";
import { parseCreate, unquote, type ColumnNode, type CreateNode, type Span, type StorageNode } from "./parser";

export const SQL_LEXICON = "sql";

export const CLICKHOUSE_ENTITY_TYPES = {
  database: "ClickHouse::Database",
  table: "ClickHouse::Table",
  view: "ClickHouse::View",
  materializedView: "ClickHouse::MaterializedView",
} as const;

export type ClickHouseEntityType = (typeof CLICKHOUSE_ENTITY_TYPES)[keyof typeof CLICKHOUSE_ENTITY_TYPES];

// ── Values ─────────────────────────────────────────────────────────────

/** A column of a table or view, as declared. Expressions are the source text with interpolations rendered. */
export interface ColumnDef {
  name: string;
  type?: string;
  nullable?: boolean;
  default?: { kind: "DEFAULT" | "MATERIALIZED" | "ALIAS" | "EPHEMERAL"; expr?: string };
  codec?: string;
  ttl?: string;
  comment?: string;
  statistics?: string;
  settings?: string;
}

export interface EngineDef {
  name: string;
  /** Each argument's text, as written. Absent when the engine is written without parentheses. */
  args?: string[];
}

/** One output column of a view and the columns it is computed from. */
export interface LineageEdge {
  output: string;
  /** The select-list expression, rendered. */
  expr: string;
  /** The column references inside it. */
  from: AttrRef[];
}

interface StorageProps {
  engine?: EngineDef;
  orderBy?: string;
  primaryKey?: string;
  partitionBy?: string;
  sampleBy?: string;
  ttl?: string;
  settings?: Record<string, string>;
}

interface CommonProps {
  /** The object's name in the database, unquoted. */
  name: string;
  /** The database it is created in, when the DDL qualifies it. */
  database?: string;
  onCluster?: string;
  comment?: string;
  /** The statement as it will be sent: the author's text, interpolations rendered. */
  ddl: string;
  /** The template's raw parts, as written, for a source round trip. */
  source: { strings: string[] };
}

export interface DatabaseProps extends CommonProps {
  engine?: EngineDef;
  settings?: Record<string, string>;
}

export interface TableProps extends CommonProps, StorageProps {
  columns: ColumnDef[];
  indexes: Array<{ name: string; expr: string; type: string; granularity?: string }>;
  projections: Array<{ name: string; definition: string }>;
  constraints: Array<{ name: string; kind: "CHECK" | "ASSUME"; expr: string }>;
  orReplace?: boolean;
  ifNotExists?: boolean;
}

export interface ViewProps extends CommonProps, StorageProps {
  /** Declared output columns; empty when the view infers them from its SELECT. */
  columns: ColumnDef[];
  /** For a refreshable materialized view, the `REFRESH` clause. */
  refresh?: string;
  append?: boolean;
  /** The target a materialized view writes into: the entity when it is declared, else its name. */
  to?: ClickHouseObject | string;
  populate?: boolean;
  empty?: boolean;
  security?: string;
  select: string;
  /** The tables and views the SELECT reads, as references. */
  reads: ClickHouseObject[];
  /** Per output column of the top-level select list, the columns it reads. */
  lineage: LineageEdge[];
  orReplace?: boolean;
  ifNotExists?: boolean;
}

/** A spliced value meant as a string literal. Made by {@link literal}. */
export class SqlLiteral {
  constructor(readonly sql: string) {
    Object.freeze(this);
  }
}

/**
 * A string as a quoted, escaped ClickHouse string literal. An interpolated
 * plain string is SQL text; wrap it in `literal()` when it is a value.
 */
export function literal(value: string | number | boolean | null): SqlLiteral {
  if (value === null) return new SqlLiteral("NULL");
  if (typeof value !== "string") return new SqlLiteral(String(value));
  return new SqlLiteral(`'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
}

// ── Entities ───────────────────────────────────────────────────────────

/** The members a ClickHouse entity has besides its props. */
export abstract class ClickHouseObject implements Declarable {
  declare readonly [DECLARABLE_MARKER]: true;
  declare readonly lexicon: "sql";
  declare readonly entityType: ClickHouseEntityType;
  declare readonly kind: "resource";
  /** The name the object is referred to by in SQL: `name`, or `database.name`. */
  declare readonly sqlName: string;
  /** The parsed definition; each entity kind narrows it. */
  declare readonly props: object;
  /**
   * Everything the DDL references, enumerable so core's dependency graph and
   * `chant graph` see the edges.
   */
  declare readonly dependsOn: readonly unknown[];
}

export interface ClickHouseDatabase extends ClickHouseObject {
  readonly entityType: "ClickHouse::Database";
  readonly props: DatabaseProps;
}

/** A table or a view: something with columns that SQL can reference. */
export interface ClickHouseRelation extends ClickHouseObject {
  /** One reference per column, by name: `${events.columns.user_id}`. */
  readonly columns: Readonly<Record<string, AttrRef>>;
}

export interface ClickHouseTable extends ClickHouseRelation {
  readonly entityType: "ClickHouse::Table";
  readonly props: TableProps;
}

export interface ClickHouseView extends ClickHouseRelation {
  readonly entityType: "ClickHouse::View" | "ClickHouse::MaterializedView";
  readonly props: ViewProps;
}

const hidden = (target: object, key: string | symbol, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });

function makeEntity(
  entityType: ClickHouseEntityType,
  sqlName: string,
  props: object,
  columnNames: readonly string[] | undefined,
  dependsOn: unknown[],
): ClickHouseObject {
  const entity = Object.create(ClickHouseObject.prototype) as ClickHouseObject;
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

export function isClickHouseObject(value: unknown): value is ClickHouseObject {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === SQL_LEXICON &&
    typeof (value as ClickHouseObject).sqlName === "string" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith("ClickHouse::")
  );
}

/** A column reference: an AttrRef whose parent is a ClickHouse table or view. */
export function isColumnRef(value: unknown): value is AttrRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<AttrRef>;
  if (typeof v.attribute !== "string" || typeof v.parent?.deref !== "function") return false;
  return isClickHouseObject(v.parent.deref());
}

// ── Rendering interpolations ───────────────────────────────────────────

/** A name as ClickHouse reads it: bare when it is a plain identifier, backquoted otherwise. */
export function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? `an object (${Object.prototype.toString.call(value)})` : `a ${typeof value}`;
}

/** The SQL text a non-reference value splices in, or an error message. */
function spliceText(value: unknown): string | { error: string } {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : { error: `the number ${value} has no SQL form` };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "NULL";
  if (value instanceof SqlLiteral) return value.sql;
  if (value === undefined) {
    return {
      error:
        "undefined. A column is referenced through `.columns` (`${events.columns.user_id}`, not " +
        "`${events.user_id}`), and a column name that does not exist is undefined too",
    };
  }
  return { error: `${describe(value)}, which has no SQL form` };
}

function renderReference(value: unknown): string {
  if (isClickHouseObject(value)) return value.sqlName;
  if (isColumnRef(value)) return quoteIdentifier(value.attribute);
  throw new TypeError(`not a reference: ${describe(value)}`);
}

// ── Building ───────────────────────────────────────────────────────────

/** Where interpolation `index` sits in the template, for a message: the line of the template it is on. */
function interpolationLine(parts: readonly string[], index: number): number {
  return parts.slice(0, index + 1).join("${}").split("\n").length;
}

/** An error from a tag: the statement kind, the template line, and what went wrong. */
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

interface Ctx {
  tokens: Token[];
  values: readonly unknown[];
}

/**
 * Splice every interpolation that is not a reference into the token list as
 * SQL text. References stay `ref` tokens for the parser and the entity to see.
 */
function splice(tag: string, parts: readonly string[], values: readonly unknown[]): Token[] {
  const out: Token[] = [];
  for (const t of tokenize(parts)) {
    if (t.kind !== "ref") {
      out.push(t);
      continue;
    }
    const value = values[t.part];
    if (isClickHouseObject(value) || isColumnRef(value)) {
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
      for (const s of tokenizeText(text, t.part)) out.push({ ...s, splice: t.part });
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

/** A span's text, interpolations rendered, trimmed. */
function text(ctx: Ctx, span: Span | undefined): string | undefined {
  if (!span || span.to <= span.from) return undefined;
  return untokenize(ctx.tokens.slice(span.from, span.to), (i) => renderReference(ctx.values[i])).trim();
}

const req = (s: string | undefined): string => s ?? "";

/** A `'quoted'` string literal's value. */
function stringValue(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!/^'.*'$/s.test(s)) return s;
  return s.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, "$1");
}

function columnDef(ctx: Ctx, c: ColumnNode): ColumnDef {
  const def: ColumnDef = { name: c.name || req(text(ctx, c.nameSpan)) };
  const set = <K extends keyof ColumnDef>(k: K, v: ColumnDef[K] | undefined) => {
    if (v !== undefined) def[k] = v;
  };
  set("type", text(ctx, c.type));
  set("nullable", c.nullable);
  if (c.default) {
    const expr = text(ctx, c.default.expr);
    def.default = expr === undefined ? { kind: c.default.kind } : { kind: c.default.kind, expr };
  }
  set("codec", text(ctx, c.codec));
  set("ttl", text(ctx, c.ttl));
  set("comment", stringValue(text(ctx, c.comment)));
  set("statistics", text(ctx, c.statistics));
  set("settings", text(ctx, c.settings));
  return def;
}

function storageProps(ctx: Ctx, node: StorageNode): StorageProps {
  const out: StorageProps = {};
  if (node.engine) {
    const name = node.engine.name || req(text(ctx, node.engine.nameSpan));
    out.engine = node.engine.args ? { name, args: node.engine.args.map((a) => req(text(ctx, a))) } : { name };
  }
  const put = (k: "orderBy" | "primaryKey" | "partitionBy" | "sampleBy" | "ttl", span: Span | undefined) => {
    const v = text(ctx, span);
    if (v !== undefined) out[k] = v;
  };
  put("orderBy", node.orderBy);
  put("primaryKey", node.primaryKey);
  put("partitionBy", node.partitionBy);
  put("sampleBy", node.sampleBy);
  put("ttl", node.ttl);
  if (node.settings) out.settings = Object.fromEntries(node.settings.map((s) => [s.key, req(text(ctx, s.value))]));
  return out;
}

/**
 * Column-level lineage of a view's SELECT: one edge per item of the top-level
 * select list. FROM, WHERE and GROUP BY stay text; the tables and views they
 * interpolate land in `reads`. A column written by name inside the SQL is not
 * lineage: only references are (#3047, "no parsing of SQL for names").
 */
function lineage(ctx: Ctx, select: Span): { edges: LineageEdge[]; reads: ClickHouseObject[] } {
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
        output = unquote(tok(items[asAt + 1]!).text);
        exprItems = items.slice(0, asAt);
      } else if (items.length === 1) {
        const t = tok(items[0]!);
        if (t.kind === "ref" && isColumnRef(ctx.values[t.part])) output = (ctx.values[t.part] as AttrRef).attribute;
        else if (t.kind === "ident" || t.kind === "qident") output = unquote(t.text);
      } else if (items.length === 3 && tok(items[1]!).text === "." && (tok(items[2]!).kind === "ident" || tok(items[2]!).kind === "qident")) {
        output = unquote(tok(items[2]!).text);
      }
      const refs = exprItems.filter((i) => tok(i).kind === "ref").map((i) => tok(i).part);
      const exprSpan: Span = { from: exprItems[0]!, to: exprItems[exprItems.length - 1]! + 1, refs };
      edges.push({
        output: output ?? `_${b + 1}`,
        expr: req(text(ctx, exprSpan)),
        from: [...new Set(refs.map((i) => ctx.values[i]).filter(isColumnRef))],
      });
    }
  }
  const reads = [...new Set(select.refs.map((i) => ctx.values[i]).filter(isClickHouseObject))];
  return { edges, reads };
}

/** `name` or `db.name` from a qualified-name span; an interpolated database entity names the database. */
function qualified(ctx: Ctx, span: Span): { database?: string; name: string } {
  const sig = ctx.tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));
  const pieces: string[] = [];
  for (const t of sig) {
    if (t.kind === "punct" && t.text === ".") continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      if (isClickHouseObject(v) && v.entityType === CLICKHOUSE_ENTITY_TYPES.database) pieces.push((v as ClickHouseDatabase).props.name);
      else pieces.push(...renderReference(v).split("."));
    } else pieces.push(unquote(t.text));
  }
  return pieces.length >= 2 ? { database: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

const strip = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false)) as T;

type Expect = "database" | "table" | "view";

function build(tag: Expect, strings: TemplateStringsArray | readonly string[], values: readonly unknown[]): ClickHouseObject {
  const parts = [...((strings as TemplateStringsArray).raw ?? strings)];
  const tokens = splice(tag, parts, values);
  let node: CreateNode;
  try {
    node = parseCreate(tokens);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    const where =
      err.token?.splice !== undefined
        ? `in the text interpolated on template line ${interpolationLine(parts, err.token.splice)}`
        : `on template line ${parts.slice(0, err.part).join("${}").split("\n").length + parts[err.part]!.slice(0, err.offset).split("\n").length - 1}`;
    throw new SqlTemplateError(tag, `${err.message} (${where})`, err.part, err.offset);
  }
  const ctx: Ctx = { tokens, values };
  if (node.statement !== tag) {
    const holds = node.statement === "database" ? "CREATE DATABASE" : node.statement === "table" ? "CREATE TABLE" : "CREATE VIEW";
    throw new SqlTemplateError(tag, `holds a ${holds}; use the ${node.statement} tag`, 0, 0);
  }
  const { database, name } = qualified(ctx, node.name);
  const sqlName = database ? `${quoteIdentifier(database)}.${quoteIdentifier(name)}` : quoteIdentifier(name);
  const ddl = req(untokenize(tokens, (i) => renderReference(values[i])).trim().replace(/;\s*$/, ""));
  const source = { strings: parts };
  const dependsOn = [...new Set(values.filter((v) => isClickHouseObject(v) || isColumnRef(v)))];
  const common = { name, database, onCluster: text(ctx, node.onCluster), comment: stringValue(text(ctx, node.comment)) };

  if (node.statement === "database") {
    const engine = node.engine
      ? node.engine.args
        ? { name: node.engine.name, args: node.engine.args.map((a) => req(text(ctx, a))) }
        : { name: node.engine.name }
      : undefined;
    const settings = node.settings
      ? Object.fromEntries(node.settings.map((s) => [s.key, req(text(ctx, s.value))]))
      : undefined;
    const props: DatabaseProps = strip({ ...common, engine, settings, ddl, source });
    return makeEntity(CLICKHOUSE_ENTITY_TYPES.database, quoteIdentifier(name), props, undefined, dependsOn);
  }

  if (node.statement === "table") {
    const columns = node.columns.map((c) => columnDef(ctx, c));
    const props: TableProps = strip({
      ...common,
      orReplace: node.orReplace,
      ifNotExists: node.ifNotExists,
      columns,
      indexes: node.indexes.map((i) =>
        strip({ name: i.name, expr: req(text(ctx, i.expr)), type: req(text(ctx, i.type)), granularity: text(ctx, i.granularity) }),
      ),
      projections: node.projections.map((p) => ({ name: p.name, definition: req(text(ctx, p.body)) })),
      constraints: node.constraints.map((c) => ({ name: c.name, kind: c.kind, expr: req(text(ctx, c.expr)) })),
      ...storageProps(ctx, node),
      ddl,
      source,
    });
    return makeEntity(CLICKHOUSE_ENTITY_TYPES.table, sqlName, props, columns.map((c) => c.name), dependsOn);
  }

  const lin = lineage(ctx, node.select);
  let to: ClickHouseObject | string | undefined;
  if (node.to) {
    const target = node.to.refs.length === 1 ? values[node.to.refs[0]!] : undefined;
    to = isClickHouseObject(target) ? target : text(ctx, node.to);
  }
  const columns = node.columns.map((c) => columnDef(ctx, c));
  const props: ViewProps = strip({
    ...common,
    orReplace: node.orReplace,
    ifNotExists: node.ifNotExists,
    refresh: text(ctx, node.refresh),
    append: node.append,
    to,
    columns,
    ...storageProps(ctx, node),
    populate: node.populate,
    empty: node.empty,
    security: text(ctx, node.security),
    select: req(text(ctx, node.select)),
    reads: lin.reads,
    lineage: lin.edges,
    ddl,
    source,
  });
  const outputs = columns.length > 0 ? columns.map((c) => c.name) : lin.edges.map((e) => e.output);
  const type = node.materialized ? CLICKHOUSE_ENTITY_TYPES.materializedView : CLICKHOUSE_ENTITY_TYPES.view;
  return makeEntity(type, sqlName, props, outputs, dependsOn);
}

/** `` database`CREATE DATABASE ...` ``: one ClickHouse database, parsed at build time. */
export function database(strings: TemplateStringsArray, ...values: unknown[]): ClickHouseDatabase {
  return build("database", strings, values) as ClickHouseDatabase;
}

/** `` table`CREATE TABLE ...` ``: one ClickHouse table, parsed at build time. */
export function table(strings: TemplateStringsArray, ...values: unknown[]): ClickHouseTable {
  return build("table", strings, values) as ClickHouseTable;
}

/**
 * `` view`CREATE [MATERIALIZED] VIEW ...` ``: one view or materialized view,
 * with the tables it reads and its column lineage.
 */
export function view(strings: TemplateStringsArray, ...values: unknown[]): ClickHouseView {
  return build("view", strings, values) as ClickHouseView;
}
