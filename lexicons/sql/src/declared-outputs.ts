/**
 * The workspace outputs a sql member exposes (#3931): each table and view,
 * and each of their columns, as names another member's link may target.
 *
 * | Dialect | Relation | Column |
 * |---|---|---|
 * | Postgres | `<schema>.<table>` | `<schema>.<table>.<column>` |
 * | ClickHouse | `<database>.<table>` | `<database>.<table>.<column>` |
 *
 * The schema is `public` when the DDL does not qualify the name, and the
 * database `default`. Views and materialized views are relations too.
 *
 * Names are the declared ones, read from the entities the member's source
 * folds to, never an environment's or a profile's rendering: a member that
 * renames its database per environment or tenant at deploy time exposes the
 * same outputs everywhere.
 *
 * Identifiers are written unquoted, in the case the dialect keeps:
 *
 * - Postgres folds an unquoted identifier to lower case and keeps a quoted
 *   one exactly, so `CREATE TABLE Orders` is `public.orders` and `CREATE
 *   TABLE "Orders"` is `public.Orders`, a different output;
 * - ClickHouse is case-sensitive, so a name is kept as written, quoted or not.
 *
 * A link's near-name hint compares names case-insensitively, so a link to
 * `public.orders` when only `public.Orders` exists is pointed at it.
 *
 * A view's columns are its declared column list, or else the names of its
 * select list (an alias, or the column a bare reference reads). A select
 * list item with no name chant can derive, or a `*`, leaves the view's
 * columns incomplete: that is a gap, so a link to one of them is unresolved
 * rather than missing.
 *
 * A `-- previously: <old>` rename hint, on a column's line or before the
 * CREATE, is reported as the output's previous name, so a link to the old
 * name says where it went.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { LexiconUnreadSource, LexiconWorkspaceOutput, LexiconWorkspaceOutputs } from "@intentius/chant/graph-ir";
import { CLICKHOUSE_ENTITY_TYPES, isClickHouseObject, type ColumnDef as ClickHouseColumnDef, type TableProps as ClickHouseTableProps, type ViewProps as ClickHouseViewProps } from "./clickhouse/entities";
import { canonicalObject } from "./clickhouse/plan/normalize";
import { isPostgresObject, POSTGRES_ENTITY_TYPES, type TableProps as PostgresTableProps, type ViewProps as PostgresViewProps } from "./postgres/entities";
import { renameHints } from "./postgres/plan/schema";
import type { LineageEdge } from "./core/references";

/** The schema an unqualified Postgres name is created in. */
export const POSTGRES_DEFAULT_SCHEMA = "public";
/** The database an unqualified ClickHouse name is created in. */
export const CLICKHOUSE_DEFAULT_DATABASE = "default";

/** A module the sql lexicon's declarations import from. */
const SQL_MODULE = /from\s+["']@intentius\/chant-lexicon-sql(\/(postgres|clickhouse|sql-files))?["']/;

interface Collected {
  outputs: Map<string, LexiconWorkspaceOutput>;
  gaps: string[];
}

function add(c: Collected, name: string, entity: string, previously: readonly string[] = []): void {
  const prev = c.outputs.get(name);
  const before = [...new Set([...(prev?.previously ?? []), ...previously.filter((p) => p !== name)])].sort();
  c.outputs.set(name, { name, entity: prev?.entity ?? entity, ...(before.length ? { previously: before } : {}) });
}

/** A relation and its columns, with the rename hints that apply. */
function addRelation(
  c: Collected,
  key: string,
  qualifier: string,
  name: string,
  columns: readonly string[],
  hints: { previously?: string; columns: Record<string, string> },
): void {
  const relation = `${qualifier}.${name}`;
  // A relation's hint names its old name, bare or qualified.
  const oldRelation = hints.previously ? (hints.previously.includes(".") ? hints.previously : `${qualifier}.${hints.previously}`) : undefined;
  add(c, relation, key, oldRelation ? [oldRelation] : []);
  for (const col of columns) {
    const prevCol = hints.columns[col];
    const previously = [
      ...(prevCol ? [`${relation}.${prevCol}`] : []),
      ...(oldRelation ? [`${oldRelation}.${col}`, ...(prevCol ? [`${oldRelation}.${prevCol}`] : [])] : []),
    ];
    add(c, `${relation}.${col}`, key, previously);
  }
}

/** A view's output columns from its select list, and whether they are all known. */
function lineageColumns(lineage: readonly LineageEdge[], unnamed: (output: string, index: number) => boolean): { columns: string[]; complete: boolean } {
  const columns: string[] = [];
  let complete = true;
  lineage.forEach((e, i) => {
    if (/(^|\.)\s*\*$/.test(e.expr.trim()) || unnamed(e.output, i + 1)) complete = false;
    else columns.push(e.output);
  });
  return { columns, complete };
}

function postgres(c: Collected, key: string, e: Declarable): void {
  const type = e.entityType;
  if (type === POSTGRES_ENTITY_TYPES.table) {
    const props = (e as unknown as { props: PostgresTableProps }).props;
    const schema = props.schema ?? POSTGRES_DEFAULT_SCHEMA;
    const columns = props.columns.map((col) => col.name);
    const inherited = (parent: unknown): string[] | undefined =>
      isPostgresObject(parent) && parent.entityType === POSTGRES_ENTITY_TYPES.table ? (parent.props as PostgresTableProps).columns.map((col) => col.name) : undefined;
    // A partition takes its parent's columns; INHERITS adds the parents'.
    if (props.partitionOf !== undefined) {
      const fromParent = inherited(props.partitionOf);
      if (fromParent) columns.push(...fromParent.filter((n) => !columns.includes(n)));
      else c.gaps.push(`table ${schema}.${props.name} (${key}) is a partition of ${String(props.partitionOf)}, which this member does not declare, so its columns are not known`);
    }
    for (const parent of props.inherits) {
      const fromParent = inherited(parent);
      if (fromParent) columns.push(...fromParent.filter((n) => !columns.includes(n)));
      else c.gaps.push(`table ${schema}.${props.name} (${key}) inherits ${String(parent)}, which this member does not declare, so its columns are not all known`);
    }
    if (props.ofType !== undefined) {
      const attrs = isPostgresObject(props.ofType) ? (props.ofType.props as { attributes?: { name: string }[] }).attributes : undefined;
      if (attrs) columns.push(...attrs.map((a) => a.name).filter((n) => !columns.includes(n)));
      else c.gaps.push(`table ${schema}.${props.name} (${key}) is OF ${String(props.ofType)}, which this member does not declare, so its columns are not known`);
    }
    if (props.like.length > 0) c.gaps.push(`table ${schema}.${props.name} (${key}) copies columns with LIKE, which are not read`);
    addRelation(c, key, schema, props.name, columns, renameHints(props.ddl));
    return;
  }
  if (type === POSTGRES_ENTITY_TYPES.view || type === POSTGRES_ENTITY_TYPES.materializedView) {
    const props = (e as unknown as { props: PostgresViewProps }).props;
    const schema = props.schema ?? POSTGRES_DEFAULT_SCHEMA;
    let columns = [...props.columns];
    if (columns.length === 0) {
      const derived = lineageColumns(props.lineage, (output) => output === "?column?");
      columns = derived.columns;
      if (!derived.complete) c.gaps.push(`view ${schema}.${props.name} (${key}) has a select list item whose name can't be read without a server (a * or an unnamed expression), so its columns are not all known`);
    }
    addRelation(c, key, schema, props.name, columns, renameHints(props.ddl));
  }
}

function clickhouseHints(ddl: string): { previously?: string; columns: Record<string, string> } {
  try {
    const o = canonicalObject(ddl, CLICKHOUSE_DEFAULT_DATABASE);
    const columns: Record<string, string> = {};
    for (const col of o.columns) if (col.previously) columns[col.name] = col.previously;
    return { ...(o.previously ? { previously: o.previously } : {}), columns };
  } catch {
    return { columns: {} };
  }
}

function clickhouse(c: Collected, key: string, e: Declarable): void {
  const type = e.entityType;
  if (type === CLICKHOUSE_ENTITY_TYPES.table) {
    const props = (e as unknown as { props: ClickHouseTableProps }).props;
    const database = props.database ?? CLICKHOUSE_DEFAULT_DATABASE;
    if (props.columns.length === 0) c.gaps.push(`table ${database}.${props.name} (${key}) declares no columns, so the server's are not known`);
    addRelation(c, key, database, props.name, props.columns.map((col: ClickHouseColumnDef) => col.name), clickhouseHints(props.ddl));
    return;
  }
  if (type === CLICKHOUSE_ENTITY_TYPES.view || type === CLICKHOUSE_ENTITY_TYPES.materializedView) {
    const props = (e as unknown as { props: ClickHouseViewProps }).props;
    const database = props.database ?? CLICKHOUSE_DEFAULT_DATABASE;
    let columns = props.columns.map((col: ClickHouseColumnDef) => col.name);
    if (columns.length === 0) {
      const derived = lineageColumns(props.lineage, (output, n) => output === `_${n}`);
      columns = derived.columns;
      if (!derived.complete) c.gaps.push(`view ${database}.${props.name} (${key}) has a select list item whose name can't be read without a server (a * or an unaliased expression), so its columns are not all known`);
    }
    addRelation(c, key, database, props.name, columns, clickhouseHints(props.ddl));
  }
}

/**
 * The `workspaceOutputs` hook: every table and view the entities declare,
 * and their columns. `unread` names the member's files that did not fold;
 * one that imports the sql lexicon may declare tables, so it is a gap.
 */
export function sqlWorkspaceOutputs(entities: ReadonlyMap<string, Declarable>, unread: readonly LexiconUnreadSource[] = []): LexiconWorkspaceOutputs | undefined {
  const c: Collected = { outputs: new Map(), gaps: [] };
  let any = false;
  for (const [key, e] of entities) {
    if (isPostgresObject(e)) {
      any = true;
      postgres(c, key, e);
    } else if (isClickHouseObject(e)) {
      any = true;
      clickhouse(c, key, e);
    }
  }
  for (const u of unread) {
    if (!SQL_MODULE.test(u.text)) continue;
    any = true;
    c.gaps.push(`${u.file} imports the sql lexicon and does not fold, so the tables it declares were not read: ${u.reason}`);
  }
  if (!any) return undefined;
  const outputs = [...c.outputs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { outputs, ...(c.gaps.length ? { gaps: c.gaps } : {}) };
}
