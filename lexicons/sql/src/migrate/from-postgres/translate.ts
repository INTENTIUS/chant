/**
 * Postgres tables into the ClickHouse tables a CDC pipeline fills (#4399).
 *
 * The input is the Postgres declarations a build reads (or a `.sql` file read
 * into the same declarations), the output a {@link Mirror} per table: its
 * ClickHouse columns, its sort key and the facts the writers need. Writing
 * the mirror as DDL or as a `CdcMirror` call is `./emit.ts`.
 *
 * What is mechanical makes no finding: the type map in `./types.ts`, names,
 * column order, a `NOT NULL` column keeping its type. Everything else is
 * decided by the shared catalog (`../../clickhouse/review-catalog.ts`): the
 * sort key from the primary key, the `ReplacingMergeTree` engine for a
 * mirror, `Nullable` against a default, `LowCardinality` candidates, and the
 * constraints ClickHouse does not enforce. This file adds what only Postgres
 * has: identity, serial and generated columns, defaults, storage options,
 * indexes that are not carried, and the objects of the file that are not
 * tables.
 *
 * A mirror's columns carry no `DEFAULT`: the pipeline writes every column of
 * a row, so the source's default has already run. That is an `info` finding
 * (SQLRV008), not a `warning`, since it changes nothing a reader of the
 * mirror sees.
 *
 * The Postgres schema is not part of the mirror's name. A pipeline chooses
 * the ClickHouse database it writes to, so `shop.customers` becomes
 * `customers` in that database. Two tables with one name in different
 * schemas keep their schema as a database qualifier (`shop.customers`).
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { ImportDiagnostic } from "@intentius/chant/import/parser";
import {
  constraintReview,
  engineReview,
  findingText,
  lowCardinalityReview,
  nullableReview,
  sortKeyReview,
  type ConstraintFact,
  type ReviewFinding,
  type ReviewRuleId,
  type SortKeyCandidate,
} from "../../clickhouse/review-catalog";
import { isPostgresObject, POSTGRES_ENTITY_TYPES, type ColumnDef, type IndexProps, type TableProps } from "../../postgres/entities";
import { mapPostgresType } from "./types";

/** The names of the columns the pipeline adds, and what `CdcMirror` calls them by default. */
export const MIRROR_COLUMNS = { version: "_version", deleted: "_is_deleted" } as const;

export interface MirrorColumn {
  name: string;
  /** The ClickHouse type, `Nullable` and `LowCardinality` decisions included. */
  type: string;
  comment?: string;
}

export interface Mirror {
  /** The export the Postgres table is declared as, or its name when the source has none. */
  export: string;
  /** The ClickHouse table name, qualified with a database only when two tables would collide. */
  name: string;
  /** The Postgres schema and table, for the workspace link. */
  source: { schema: string; table: string };
  columns: MirrorColumn[];
  /** The sort key; empty means `tuple()`. */
  primaryKey: string[];
  /** MergeTree settings the key needs. */
  settings: Record<string, string>;
  /** `-- ` lines for constraints ClickHouse does not enforce. */
  constraintComments: string[];
  /** The table's description, which `CdcMirror` has no place for. */
  comment?: string;
}

export interface Translation {
  mirrors: Mirror[];
  diagnostics: ImportDiagnostic[];
  /** The Postgres outputs each mirrored column reads, as a workspace link names them (`shop.customers.email`). */
  outputs: string[];
}

export interface TranslateOptions {
  /** The mirror is a `CdcMirror` call: a table description has no place in it. */
  composite: boolean;
}

const DEFAULT_SCHEMA = "public";

const ident = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

class Report {
  readonly diagnostics: ImportDiagnostic[] = [];
  finding(f: ReviewFinding): void {
    this.diagnostics.push({ ruleId: f.ruleId, severity: f.severity, message: findingText(f), entity: f.object });
  }
  /** A finding of this file's own. `error` marks a table the translation refuses; the catalog's findings never are. */
  note(ruleId: ReviewRuleId, severity: "warning" | "info" | "error", object: string, message: string, evidence: string[], column?: string, suggestion?: string): void {
    const text = findingText({ ruleId, severity: severity === "error" ? "warning" : severity, object, ...(column ? { column } : {}), message, evidence, ...(suggestion ? { suggestion } : {}) });
    this.diagnostics.push({ ruleId, severity, message: text, entity: object });
  }
}

const propsOf = <P>(e: Declarable): P => (e as unknown as { props: P }).props;
const display = (schema: string | undefined, name: string): string => (schema ? `${schema}.${name}` : name);

/** The Postgres tables among `entities`, in the order given, with the export each is declared as. */
function tablesOf(entities: ReadonlyMap<string, Declarable>): Array<{ key: string; props: TableProps }> {
  const out: Array<{ key: string; props: TableProps }> = [];
  for (const [key, e] of entities) if (isPostgresObject(e) && e.entityType === POSTGRES_ENTITY_TYPES.table) out.push({ key, props: propsOf<TableProps>(e) });
  return out;
}

/** Whether an index is on this table: its table is named bare, or with the schema, as the DDL wrote it. */
const tableMatches = (ix: IndexProps, t: TableProps): boolean => {
  const target = ix.tableName.replace(/"/g, "");
  return target === t.name || target === `${t.schema ?? DEFAULT_SCHEMA}.${t.name}`;
};

function translateTable(
  key: string,
  t: TableProps,
  indexes: readonly IndexProps[],
  mirrorName: string,
  opts: TranslateOptions,
  report: Report,
): Mirror | undefined {
  const schema = t.schema ?? DEFAULT_SCHEMA;
  const object = display(t.schema, t.name);
  const pk = new Set(t.primaryKey?.columns ?? []);

  for (const reserved of Object.values(MIRROR_COLUMNS)) {
    if (t.columns.some((c) => c.name === reserved)) {
      report.note("SQLRV011", "error", object, `The table is not carried: it already has a column named ${reserved}, which the mirror adds.`, [`column ${reserved} in the source`], reserved, "Rename the source column, or name the pipeline's columns otherwise in the CdcMirror call.");
      return undefined;
    }
  }
  if (opts.composite && !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(mirrorName)) {
    report.note("SQLRV011", "error", object, `The table is not carried: CdcMirror writes the name ${mirrorName} unquoted, and it needs quoting.`, [`the name ${mirrorName} is not a plain identifier`], undefined, "Emit without --use-composites to keep the quoted name, or rename the table.");
    return undefined;
  }
  if (t.partitionOf !== undefined) {
    report.note("SQLRV011", "info", object, "A partition is not carried; its rows reach the mirror through the parent table.", [`PARTITION OF ${typeof t.partitionOf === "string" ? t.partitionOf : "the parent"}`]);
    return undefined;
  }
  const unread: string[] = [];
  if (t.like.length > 0) unread.push(...t.like.map((l) => `LIKE ${l}`));
  if (t.inherits.length > 0) unread.push(`INHERITS (${t.inherits.map((i) => (typeof i === "string" ? i : "a declared table")).join(", ")})`);
  if (t.ofType !== undefined) unread.push(`OF ${typeof t.ofType === "string" ? t.ofType : "a declared type"}`);
  if (unread.length > 0) {
    report.note("SQLRV011", "warning", object, "Columns that come from LIKE, INHERITS or OF are not read.", unread, undefined, "Add the columns to the CdcMirror call by hand, or declare them in the table.");
  }

  const columnTypes: Record<string, string> = {};
  const columns: MirrorColumn[] = [];
  const maxLengths = new Map<string, number>();
  const droppedStorage: string[] = [];

  for (const col of t.columns) {
    const m = mapPostgresType(col.type ?? "");
    if (m.note) report.note("SQLRV007", "warning", object, m.note.message, m.note.evidence, col.name);
    if (m.maxLength !== undefined) maxLengths.set(col.name, m.maxLength);
    describeGenerated(col, m.serial === true, object, report);
    if (col.default !== undefined && col.generated === undefined && !(m.serial && /nextval\(/i.test(col.default))) {
      report.note(
        "SQLRV008",
        "info",
        object,
        `The default of ${col.name} is not carried.`,
        [`DEFAULT ${oneLine(col.default)}`, "the pipeline writes every column of a row, so the source has already run the default"],
        col.name,
        "Add a ClickHouse DEFAULT if the table is also written by something other than the pipeline.",
      );
    }
    if (col.collate) {
      report.note("SQLRV007", "warning", object, `Collation ${col.collate} on ${col.name} is not carried.`, ["ClickHouse compares String values as bytes; a Postgres collation orders them by locale"], col.name);
    }
    if (col.compression) droppedStorage.push(`column ${col.name} COMPRESSION ${col.compression}`);
    if (col.storage) droppedStorage.push(`column ${col.name} STORAGE ${col.storage}`);

    // A primary key column, an identity column and a serial column are NOT NULL whatever the DDL says.
    const forcedNotNull = pk.has(col.name) || col.generated?.kind === "identity" || m.serial === true;
    const sourceNullable = m.array === true ? false : !(col.notNull === true || forcedNotNull);
    const n = nullableReview({ object, column: col.name, type: m.type, sourceNullable, ...(col.default !== undefined && sourceNullable ? { defaultExpr: oneLine(col.default) } : {}) });
    if (n.finding) report.finding(n.finding);
    columnTypes[col.name] = n.type;
    const lc = lowCardinalityReview({ object, column: col.name, type: n.type, ...(m.maxLength !== undefined ? { maxLength: m.maxLength } : {}) });
    if (lc) report.finding(lc);
    columns.push({ name: col.name, type: n.type, ...(col.comment ? { comment: col.comment } : {}) });
  }
  if (columns.length === 0) {
    report.note("SQLRV011", "error", object, "The table is not carried: it declares no column.", ["the CREATE TABLE lists no column"]);
    return undefined;
  }

  // Sort key: the primary key, else the first unique key.
  const uniqueIndex = indexes.find((i) => i.unique === true && i.elements.every((e) => e.column !== undefined));
  const candidates: SortKeyCandidate[] = [];
  if (t.primaryKey && t.primaryKey.columns.length > 0) {
    candidates.push({ kind: "primary-key", ...(t.primaryKey.name ? { name: t.primaryKey.name } : {}), columns: t.primaryKey.columns, source: `PRIMARY KEY${t.primaryKey.name ? ` ${t.primaryKey.name}` : ""}` });
  }
  const firstUnique = t.uniques[0];
  if (firstUnique) candidates.push({ kind: "unique-key", ...(firstUnique.name ? { name: firstUnique.name } : {}), columns: firstUnique.columns, source: `UNIQUE${firstUnique.name ? ` ${firstUnique.name}` : ""}` });
  else if (uniqueIndex) candidates.push({ kind: "unique-key", name: uniqueIndex.name, columns: uniqueIndex.elements.map((e) => e.column!), source: `CREATE UNIQUE INDEX ${uniqueIndex.name}` });
  const sortKey = sortKeyReview({ object, candidates: candidates.filter((c) => c.columns.every((c2) => c2 in columnTypes)), columnTypes });
  report.finding(sortKey.finding);
  if (opts.composite && Object.keys(sortKey.settings).length > 0) {
    report.note(
      "SQLRV001",
      "warning",
      object,
      `The CdcMirror call has no SETTINGS, so ${Object.keys(sortKey.settings).join(", ")} is not set.`,
      [`the sort key has a Nullable column and needs ${Object.entries(sortKey.settings).map(([k, v]) => `${k} = ${v}`).join(", ")}`],
      undefined,
      "Emit without --use-composites to keep the setting, or make the key columns NOT NULL in Postgres.",
    );
  }

  const engine = engineReview({
    object,
    mode: "cdc",
    cdcColumns: { version: MIRROR_COLUMNS.version, deleted: MIRROR_COLUMNS.deleted },
    ...(sortKey.orderBy.length > 0 ? { uniqueKey: sortKey.orderBy } : {}),
    facts: [`the table is declared in Postgres${t.persistence ? ` as ${t.persistence}` : ""}`],
  });
  report.finding(engine.finding);

  // Constraints ClickHouse does not enforce.
  const facts: ConstraintFact[] = [];
  for (const fk of t.foreignKeys) {
    facts.push({ kind: "foreign-key", ...(fk.name ? { name: fk.name } : {}), columns: fk.columns, references: { table: fk.refTable, columns: fk.refColumns } });
  }
  for (const u of t.uniques) facts.push({ kind: "unique", ...(u.name ? { name: u.name } : {}), columns: u.columns });
  for (const ix of indexes) {
    if (ix.unique === true && ix.elements.every((e) => e.column !== undefined)) facts.push({ kind: "unique", name: ix.name, columns: ix.elements.map((e) => e.column!) });
  }
  for (const c of t.checks) facts.push({ kind: "check", ...(c.name ? { name: c.name } : {}), expression: c.expr });
  for (const x of t.exclusions) facts.push({ kind: "exclusion", ...(x.name ? { name: x.name } : {}), expression: `${x.using ? `USING ${x.using} ` : ""}(${x.elements})` });
  const constraints = constraintReview({ object, constraints: facts });
  for (const f of constraints.findings) report.finding(f);

  // Indexes that are not carried.
  for (const ix of indexes) {
    if (ix.unique === true && ix.elements.every((e) => e.column !== undefined)) continue;
    const on = ix.elements.map((e) => e.column ?? oneLine(e.expr)).join(", ");
    report.note(
      "SQLRV009",
      "warning",
      object,
      `${ix.name}${ix.unique ? ", a unique index," : ", an index,"} on (${on}) is not carried.`,
      [`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name}${ix.method ? ` USING ${ix.method}` : ""}${ix.where ? ` WHERE ${oneLine(ix.where)}` : ""}`],
      undefined,
      "The sort key is the only index a MergeTree table has by default. A skip index (minmax, set, bloom_filter) on the column can prune granules.",
    );
  }

  // Storage the source chose.
  const dropped = [...droppedStorage];
  if (t.partitionBy) dropped.push(`PARTITION BY ${oneLine(t.partitionBy)}`);
  if (t.with) dropped.push(`WITH ${oneLine(t.with)}`);
  if (t.tablespace) dropped.push(`TABLESPACE ${t.tablespace}`);
  if (t.using) dropped.push(`USING ${t.using}`);
  if (t.persistence) dropped.push(t.persistence.toUpperCase());
  if (t.rowSecurity === true) dropped.push("ROW LEVEL SECURITY");
  if (dropped.length > 0) {
    report.note("SQLRV009", "warning", object, "Storage options of the source table are not carried.", dropped, undefined, "Choose PARTITION BY for the mirror from how it is queried; a source partition is by the write path, a ClickHouse one by the read path.");
  }

  if (t.comment && opts.composite) {
    report.note("SQLRV011", "info", object, "The table's description is not carried: the CdcMirror call has no place for it.", [`COMMENT ON TABLE: ${oneLine(t.comment)}`], undefined, "Emit without --use-composites to keep it as a COMMENT clause.");
  }

  return {
    export: key,
    name: mirrorName,
    source: { schema, table: t.name },
    columns,
    primaryKey: sortKey.orderBy,
    settings: sortKey.settings,
    constraintComments: constraints.comments,
    ...(t.comment && !opts.composite ? { comment: t.comment } : {}),
  };
}

/** Identity, serial and generated columns: plain columns here, said once each. */
function describeGenerated(col: ColumnDef, serial: boolean, object: string, report: Report): void {
  if (col.generated?.kind === "identity") {
    report.note(
      "SQLRV006",
      "info",
      object,
      `Identity column ${col.name} is a plain column here.`,
      [`GENERATED ${col.generated.always ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${col.generated.options ? ` (${oneLine(col.generated.options)})` : ""}`, "ClickHouse has no auto-increment column, and the pipeline loads the value the source made"],
      col.name,
    );
  } else if (col.generated !== undefined) {
    report.note(
      "SQLRV006",
      "warning",
      object,
      `Generated column ${col.name} is a plain column here.`,
      [`GENERATED ALWAYS AS (${oneLine(col.generated.expr ?? "")}) ${col.generated.kind.toUpperCase()}`, "the pipeline loads the stored value; a virtual column is not sent by every pipeline"],
      col.name,
      col.generated.kind === "virtual" ? "Add the column as ALIAS or MATERIALIZED with the expression rewritten in ClickHouse SQL, if the pipeline does not send it." : undefined,
    );
  } else if (serial) {
    report.note("SQLRV006", "info", object, `Serial column ${col.name} is a plain integer column here.`, ["serial draws from a sequence, which ClickHouse does not have, and the pipeline loads the value the source made"], col.name);
  }
}

/** What an object of the source that is not a table is called in a finding. */
function describeObject(e: Declarable): string {
  const props = propsOf<{ name?: string; schema?: string }>(e);
  return `${e.entityType.replace(/^Postgres::/, "").toLowerCase()} ${display(props.schema, props.name ?? "?")}`;
}

export function translatePostgres(entities: ReadonlyMap<string, Declarable>, opts: TranslateOptions): Translation {
  const report = new Report();
  const tables = tablesOf(entities);
  const indexes = [...entities.values()].filter((e) => isPostgresObject(e) && e.entityType === POSTGRES_ENTITY_TYPES.index).map((e) => propsOf<IndexProps>(e));

  // Names: a table keeps its bare name unless another schema has a table of that name.
  const counts = new Map<string, number>();
  for (const { props } of tables) counts.set(props.name, (counts.get(props.name) ?? 0) + 1);
  const schemas = new Set(tables.map(({ props }) => props.schema).filter((s): s is string => s !== undefined && s !== DEFAULT_SCHEMA));

  const mirrors: Mirror[] = [];
  for (const { key, props } of tables) {
    const collides = (counts.get(props.name) ?? 0) > 1;
    const name = collides ? display(props.schema ?? DEFAULT_SCHEMA, props.name) : props.name;
    if (collides) {
      report.note("SQLRV011", "info", display(props.schema, props.name), `The table keeps its schema as a database, ${name}, because two schemas declare a table of this name.`, ["the Postgres schema is otherwise not part of the mirror's name"]);
    }
    const mine = indexes.filter((ix) => tableMatches(ix, props));
    const m = translateTable(key, props, mine, name, opts, report);
    if (m) mirrors.push(m);
  }
  for (const s of [...schemas].sort()) {
    report.note(
      "SQLRV011",
      "info",
      s,
      `Schema ${s} is not part of the mirror's name.`,
      ["a pipeline writes to one ClickHouse database, which the profile or the pipeline names"],
      undefined,
      `Create the tables in the database your pipeline targets (${s} is a common choice).`,
    );
  }

  // Everything else the source declares: named once, with no decision to make.
  for (const e of entities.values()) {
    if (!isPostgresObject(e)) continue;
    if (e.entityType === POSTGRES_ENTITY_TYPES.table || e.entityType === POSTGRES_ENTITY_TYPES.index || e.entityType === POSTGRES_ENTITY_TYPES.schema) continue;
    report.note("SQLRV011", "info", describeObject(e), `Not carried: ${describeObject(e)}.`, ["a mirror is made of tables; this object is not one"]);
  }

  const outputs = mirrors.flatMap((m) => m.columns.map((c) => `${m.source.schema}.${m.source.table}.${c.name}`));
  return { mirrors, diagnostics: report.diagnostics, outputs };
}
