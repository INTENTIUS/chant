/**
 * The ClickHouse entities: `database`, `table`, `view` and `dictionary` (#3682)
 * tagged templates that parse their DDL at fold time into one Declarable each
 * (chant #3196, #3197).
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

import type { AttrRef } from "@intentius/chant/attrref";
import { setInterpolationFields } from "@intentius/chant/provenance";
import { CLICKHOUSE_LEXICAL, isTrivia, SqlSyntaxError, untokenize } from "./tokens";
import { parseCreate, unquote, type ColumnNode, type CreateNode, type Span, type StorageNode } from "./parser";
import { feed, lineage, spanText as text, splice as spliceWith, templateSyntaxError, type TemplateCtx, type TemplateDialect } from "../core/interpolation";
import { SQL_LEXICON, SqlObject, isColumnRefOf, isSqlObjectOf, makeSqlEntity } from "../core/entity";
import type { LineageEdge } from "../core/references";
import { SqlLiteral, SqlTemplateError, describeValue as describe, stripUnset as strip, templateParts } from "../core/template";

export { SQL_LEXICON } from "../core/entity";
export type { LineageEdge } from "../core/references";
export { SqlLiteral, SqlTemplateError, templateParts, unescapeTemplateDelimiters } from "../core/template";

export const CLICKHOUSE_ENTITY_TYPES = {
  database: "ClickHouse::Database",
  table: "ClickHouse::Table",
  view: "ClickHouse::View",
  materializedView: "ClickHouse::MaterializedView",
  dictionary: "ClickHouse::Dictionary",
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

/** One attribute of a dictionary, as declared. */
export interface DictionaryAttributeDef {
  name: string;
  type: string;
  /** The value for a key the source does not have: `DEFAULT expr`. */
  default?: string;
  /** `EXPRESSION expr`: what the source computes the attribute from. */
  expression?: string;
  /** `HIERARCHICAL`, `BIDIRECTIONAL`, `INJECTIVE`, `IS_OBJECT_ID`, as written. */
  flags?: string[];
}

export interface DictionaryProps extends CommonProps {
  /** The attributes, key columns included. */
  columns: DictionaryAttributeDef[];
  /** The key columns: `PRIMARY KEY id`. */
  primaryKey: string;
  /** What is inside `SOURCE(...)`: `CLICKHOUSE(TABLE 'rates' DB 'shop')`. */
  dataSource: string;
  /** What is inside `LAYOUT(...)`: `HASHED()`. */
  layout: string;
  /** What is inside `LIFETIME(...)`: `300`, `MIN 0 MAX 300`. */
  lifetime?: string;
  /** What is inside `RANGE(...)`, for a range layout. */
  range?: string;
  settings?: Record<string, string>;
  orReplace?: boolean;
  ifNotExists?: boolean;
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

/** The members a ClickHouse entity has besides its props (the shared core's {@link SqlObject}). */
export abstract class ClickHouseObject extends SqlObject {
  declare readonly entityType: ClickHouseEntityType;
  /** The name the object is referred to by in SQL: `name`, or `database.name`. */
  declare readonly sqlName: string;
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

/** A dictionary: its attributes are columns `dictGet` reads, so SQL can reference them. */
export interface ClickHouseDictionary extends ClickHouseRelation {
  readonly entityType: "ClickHouse::Dictionary";
  readonly props: DictionaryProps;
}

function makeEntity(
  entityType: ClickHouseEntityType,
  sqlName: string,
  props: object,
  columnNames: readonly string[] | undefined,
  dependsOn: unknown[],
): ClickHouseObject {
  return makeSqlEntity(ClickHouseObject.prototype as ClickHouseObject, entityType, sqlName, props, columnNames, dependsOn);
}

export function isClickHouseObject(value: unknown): value is ClickHouseObject {
  return isSqlObjectOf(value, "ClickHouse::");
}

/** A column reference: an AttrRef whose parent is a ClickHouse table or view. */
export function isColumnRef(value: unknown): value is AttrRef {
  return isColumnRefOf(value, isClickHouseObject);
}

// ── Rendering interpolations ───────────────────────────────────────────

/** A name as ClickHouse reads it: bare when it is a plain identifier, backquoted otherwise. */
export function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
}

function renderReference(value: unknown): string {
  if (isClickHouseObject(value)) return value.sqlName;
  if (isColumnRef(value)) return quoteIdentifier(value.attribute);
  throw new TypeError(`not a reference: ${describe(value)}`);
}

// ── Building ───────────────────────────────────────────────────────────

/** ClickHouse as the shared template machinery reads it (`../core/interpolation.ts`). */
export const CLICKHOUSE_TEMPLATES: TemplateDialect = {
  lexical: CLICKHOUSE_LEXICAL,
  isObject: isClickHouseObject,
  isColumnRef,
  renderReference,
  identValue: unquote,
  unnamedOutput: (n) => `_${n}`,
};

type Ctx = TemplateCtx;

/** The tag's splice: plain values become SQL text, references stay `ref` tokens. */
const splice = (tag: string, parts: readonly string[], values: readonly unknown[]) => spliceWith(CLICKHOUSE_TEMPLATES, tag, parts, values);

const req = (s: string | undefined): string => s ?? "";

/** A `'quoted'` string literal's value. */
function stringValue(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!/^'.*'$/s.test(s)) return s;
  return s.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, "$1");
}

function columnDef(ctx: Ctx, c: ColumnNode): ColumnDef {
  for (const span of [c.nameSpan, c.type, c.default?.expr, c.codec, c.ttl, c.comment, c.statistics, c.settings]) feed(ctx, span, "columns");
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
    feed(ctx, node.engine.nameSpan, "engine.name");
    const name = node.engine.name || req(text(ctx, node.engine.nameSpan));
    out.engine = node.engine.args ? { name, args: node.engine.args.map((a) => req(text(ctx, a, "engine.args"))) } : { name };
  }
  const put = (k: "orderBy" | "primaryKey" | "partitionBy" | "sampleBy" | "ttl", span: Span | undefined) => {
    const v = text(ctx, span, k);
    if (v !== undefined) out[k] = v;
  };
  put("orderBy", node.orderBy);
  put("primaryKey", node.primaryKey);
  put("partitionBy", node.partitionBy);
  put("sampleBy", node.sampleBy);
  put("ttl", node.ttl);
  feed(ctx, node.settingsClause, "settings");
  if (node.settings) out.settings = Object.fromEntries(node.settings.map((s) => [s.key, req(text(ctx, s.value, "settings"))]));
  return out;
}

/** `name` or `db.name` from a qualified-name span; an interpolated database entity names the database. */
function qualified(ctx: Ctx, span: Span): { database?: string; name: string } {
  const sig = ctx.tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));
  const pieces: string[] = [];
  const splices: Array<number | undefined> = [];
  for (const t of sig) {
    if (t.kind === "punct" && t.text === ".") continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      const refPieces = isClickHouseObject(v) && v.entityType === CLICKHOUSE_ENTITY_TYPES.database
        ? [(v as ClickHouseDatabase).props.name]
        : renderReference(v).split(".");
      for (const piece of refPieces) {
        pieces.push(piece);
        splices.push(undefined);
      }
    } else {
      pieces.push(unquote(t.text));
      splices.push(t.splice);
    }
  }
  const last = pieces.length - 1;
  splices.forEach((splice, i) => {
    if (splice !== undefined) ctx.fed[splice]!.add(i === last ? "name" : "database");
  });
  return pieces.length >= 2 ? { database: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

type Expect = "database" | "table" | "view" | "dictionary";

function build(tag: Expect, strings: TemplateStringsArray | readonly string[], values: readonly unknown[]): ClickHouseObject {
  const parts = templateParts(strings);
  const tokens = splice(tag, parts, values);
  let node: CreateNode;
  try {
    node = parseCreate(tokens);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    throw templateSyntaxError(tag, parts, err);
  }
  const ctx: Ctx = { d: CLICKHOUSE_TEMPLATES, tokens, values, fed: values.map(() => new Set<string>()) };
  for (const t of tokens) if (t.splice !== undefined) ctx.fed[t.splice]!.add("ddl");
  if (node.statement !== tag) {
    const holds =
      node.statement === "database" ? "CREATE DATABASE" : node.statement === "table" ? "CREATE TABLE" : node.statement === "dictionary" ? "CREATE DICTIONARY" : "CREATE VIEW";
    throw new SqlTemplateError(tag, `holds a ${holds}; use the ${node.statement} tag`, 0, 0);
  }
  const { database, name } = qualified(ctx, node.name);
  const sqlName = database ? `${quoteIdentifier(database)}.${quoteIdentifier(name)}` : quoteIdentifier(name);
  const ddl = req(untokenize(tokens, (i) => renderReference(values[i])).trim().replace(/;\s*$/, ""));
  const source = { strings: parts };
  const dependsOn = [...new Set(values.filter((v) => isClickHouseObject(v) || isColumnRef(v)))];
  const common = {
    name,
    database,
    onCluster: text(ctx, node.onCluster, "onCluster"),
    comment: stringValue(text(ctx, node.comment, "comment")),
  };
  const done = <T extends ClickHouseObject>(entity: T): T => {
    setInterpolationFields(entity, ctx.fed.map((paths) => [...paths].sort()));
    return entity;
  };

  if (node.statement === "database") {
    feed(ctx, node.engine?.nameSpan, "engine.name");
    const engine = node.engine
      ? node.engine.args
        ? { name: node.engine.name, args: node.engine.args.map((a) => req(text(ctx, a, "engine.args"))) }
        : { name: node.engine.name }
      : undefined;
    const settings = node.settings
      ? Object.fromEntries(node.settings.map((s) => [s.key, req(text(ctx, s.value, "settings"))]))
      : undefined;
    const props: DatabaseProps = strip({ ...common, engine, settings, ddl, source });
    return done(makeEntity(CLICKHOUSE_ENTITY_TYPES.database, quoteIdentifier(name), props, undefined, dependsOn));
  }

  if (node.statement === "table") {
    const columns = node.columns.map((c) => columnDef(ctx, c));
    const props: TableProps = strip({
      ...common,
      orReplace: node.orReplace,
      ifNotExists: node.ifNotExists,
      columns,
      indexes: node.indexes.map((i) =>
        strip({
          name: i.name,
          expr: req(text(ctx, i.expr, "indexes")),
          type: req(text(ctx, i.type, "indexes")),
          granularity: text(ctx, i.granularity, "indexes"),
        }),
      ),
      projections: node.projections.map((p) => ({ name: p.name, definition: req(text(ctx, p.body, "projections")) })),
      constraints: node.constraints.map((c) => ({ name: c.name, kind: c.kind, expr: req(text(ctx, c.expr, "constraints")) })),
      ...storageProps(ctx, node),
      ddl,
      source,
    });
    return done(makeEntity(CLICKHOUSE_ENTITY_TYPES.table, sqlName, props, columns.map((c) => c.name), dependsOn));
  }

  if (node.statement === "dictionary") {
    const columns: DictionaryAttributeDef[] = node.attributes.map((a) => {
      for (const span of [a.nameSpan, a.type, a.default, a.expression]) feed(ctx, span, "columns");
      return strip({
        name: a.name || req(text(ctx, a.nameSpan)),
        type: req(text(ctx, a.type)),
        default: text(ctx, a.default),
        expression: text(ctx, a.expression),
        flags: a.flags.length > 0 ? a.flags : undefined,
      });
    });
    const settings = text(ctx, node.settings, "settings");
    const props: DictionaryProps = strip({
      ...common,
      orReplace: node.orReplace,
      ifNotExists: node.ifNotExists,
      columns,
      primaryKey: req(text(ctx, node.primaryKey, "primaryKey")),
      dataSource: req(text(ctx, node.source, "dataSource")),
      layout: req(text(ctx, node.layout, "layout")),
      lifetime: text(ctx, node.lifetime, "lifetime"),
      range: text(ctx, node.range, "range"),
      settings: settings === undefined ? undefined : dictionarySettings(settings),
      ddl,
      source,
    });
    return done(makeEntity(CLICKHOUSE_ENTITY_TYPES.dictionary, sqlName, props, columns.map((c) => c.name), dependsOn));
  }

  const lin = lineage<ClickHouseObject>(ctx, node.select);
  let to: ClickHouseObject | string | undefined;
  if (node.to) {
    const target = node.to.refs.length === 1 ? values[node.to.refs[0]!] : undefined;
    to = isClickHouseObject(target) ? target : text(ctx, node.to, "to");
  }
  const columns = node.columns.map((c) => columnDef(ctx, c));
  const props: ViewProps = strip({
    ...common,
    orReplace: node.orReplace,
    ifNotExists: node.ifNotExists,
    refresh: text(ctx, node.refresh, "refresh"),
    append: node.append,
    to,
    columns,
    ...storageProps(ctx, node),
    populate: node.populate,
    empty: node.empty,
    security: text(ctx, node.security, "security"),
    select: req(text(ctx, node.select, "select")),
    reads: lin.reads,
    lineage: lin.edges,
    ddl,
    source,
  });
  const outputs = columns.length > 0 ? columns.map((c) => c.name) : lin.edges.map((e) => e.output);
  const type = node.materialized ? CLICKHOUSE_ENTITY_TYPES.materializedView : CLICKHOUSE_ENTITY_TYPES.view;
  feed(ctx, node.select, "lineage");
  return done(makeEntity(type, sqlName, props, outputs, dependsOn));
}

/** `a = 1, b = 'x'` as a record of each setting's value as written. */
function dictionarySettings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  let cur = "";
  const flush = () => {
    const at = cur.indexOf("=");
    if (at > 0) out[cur.slice(0, at).trim()] = cur.slice(at + 1).trim();
    cur = "";
  };
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return out;
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

/**
 * `` dictionary`CREATE DICTIONARY ...` ``: one dictionary, its attributes,
 * key, source, layout and lifetime, parsed at build time (#3682). Its
 * attributes are columns: `${rates.columns.rate}`.
 */
export function dictionary(strings: TemplateStringsArray, ...values: unknown[]): ClickHouseDictionary {
  return build("dictionary", strings, values) as ClickHouseDictionary;
}
