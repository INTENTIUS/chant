/**
 * T-SQL DDL into ClickHouse `CREATE` statements, with a needs-review finding
 * for every judgment call (#4398).
 *
 * What is mechanical (the type map in `./types.ts`, names, column order) makes
 * no finding. Everything else is decided by the shared catalog
 * (`../clickhouse/review-catalog.ts`): the sort key, the engine, `Nullable`
 * against a default, `LowCardinality` candidates and the constraints
 * ClickHouse does not enforce. This file adds the rules only T-SQL has:
 * identity, sequence and computed columns, default expressions, storage
 * options, indexes that are not carried, and a view's query text.
 *
 * A schema other than `dbo` becomes a ClickHouse database of that name.
 * The `dbo` schema is the default and is dropped from names.
 *
 * Nothing is left out silently: a statement this source does not read is a
 * `refused` entry naming it, and an object it reads but does not carry (an
 * index, a `DROP`, an extended property that is not a description) is an
 * `info` or `warning` finding.
 */

import { CLICKHOUSE_ENTITY_TYPES } from "../clickhouse/entities";
import type { ImportedObject } from "../clickhouse/import/ir";
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
} from "../clickhouse/review-catalog";
import type { ImportDiagnostic } from "@intentius/chant/import/parser";
import { parseTsql, type AlterConstraintAst, type ColumnAst, type ConstraintAst, type IndexAst, type Loc, type QName, type TableAst, type ViewAst } from "./parse";
import { mapType } from "./types";
import { upper, type Token } from "./lexer";

export interface TranslateOptions {
  /** Where the refusals go: a statement this source cannot read is listed as a warning instead of failing the import. */
  skipUnreadable?: boolean;
}

export interface Translation {
  objects: ImportedObject[];
  diagnostics: ImportDiagnostic[];
  /** Statements refused or unread, as lines naming them. Empty when the file imports. */
  problems: string[];
}

const DEFAULT_SCHEMA = "dbo";

const ident = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``);
const chString = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A table's identity: schema and name, compared without regard to case as SQL Server's default collation does. */
const keyOf = (q: QName): string => {
  const n = q.parts[q.parts.length - 1]!;
  const s = q.parts.length >= 2 ? q.parts[q.parts.length - 2]! : DEFAULT_SCHEMA;
  return `${s}.${n}`.toLowerCase();
};
const schemaOf = (q: QName): string => (q.parts.length >= 2 ? q.parts[q.parts.length - 2]! : DEFAULT_SCHEMA);
const nameOf = (q: QName): string => q.parts[q.parts.length - 1]!;
const display = (q: QName): string => (schemaOf(q).toLowerCase() === DEFAULT_SCHEMA ? nameOf(q) : `${schemaOf(q)}.${nameOf(q)}`);
const databaseOf = (q: QName): string | undefined => (schemaOf(q).toLowerCase() === DEFAULT_SCHEMA ? undefined : schemaOf(q));
const qualified = (q: QName): string => {
  const db = databaseOf(q);
  return db ? `${ident(db)}.${ident(nameOf(q))}` : ident(nameOf(q));
};

class Report {
  readonly diagnostics: ImportDiagnostic[] = [];
  finding(f: ReviewFinding): void {
    this.diagnostics.push({
      ruleId: f.ruleId,
      severity: f.severity,
      message: findingText(f),
      ...(f.at ? { line: f.at.line, column: f.at.column } : {}),
      entity: f.object,
    });
  }
  note(ruleId: ReviewRuleId, severity: "warning" | "info", object: string, message: string, evidence: string[], at: Loc, column?: string, suggestion?: string): void {
    this.finding({ ruleId, severity, object, ...(column ? { column } : {}), message, evidence, ...(suggestion ? { suggestion } : {}), at });
  }
}

// --- defaults ------------------------------------------------------------------------

interface TranslatedDefault {
  kind: "none" | "literal" | "function" | "sequence" | "untranslated";
  expr?: string;
  source: string;
}

/** Strip redundant outer parentheses: SQL Server stores `DEFAULT ((0))`. */
function unwrap(tokens: readonly Token[]): Token[] {
  let t = [...tokens];
  while (t.length >= 2 && t[0]!.kind === "punct" && t[0]!.value === "(" && t[t.length - 1]!.kind === "punct" && t[t.length - 1]!.value === ")") {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i]!.value === "(" && t[i]!.kind === "punct") depth++;
      if (t[i]!.value === ")" && t[i]!.kind === "punct") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1);
  }
  return t;
}

const NOW_FUNCTIONS = new Set(["sysdatetime", "sysdatetimeoffset", "sysutcdatetime", "getdate", "getutcdate", "current_timestamp"]);

function translateDefault(c: ConstraintAst | undefined, chType: string): TranslatedDefault {
  if (!c || !c.expressionTokens) return { kind: "none", source: "" };
  const source = oneLine(c.expression ?? "");
  const t = unwrap(c.expressionTokens);
  const words = t.map((x) => x.value.toUpperCase());
  if (t.length === 1 && t[0]!.kind === "number") return { kind: "literal", expr: t[0]!.value, source };
  if (t.length === 2 && t[0]!.kind === "punct" && (t[0]!.value === "-" || t[0]!.value === "+") && t[1]!.kind === "number") return { kind: "literal", expr: `${t[0]!.value === "-" ? "-" : ""}${t[1]!.value}`, source };
  if (t.length === 1 && t[0]!.kind === "string") return { kind: "literal", expr: chString(t[0]!.value), source };
  if (t.length === 1 && upper(t[0]) === "NULL") return { kind: "none", source };
  if (words[0] === "NEXT" && words[1] === "VALUE" && words[2] === "FOR") return { kind: "sequence", source };
  const call = t.length >= 3 && t[0]!.kind === "word" && t[1]!.value === "(" && t[t.length - 1]!.value === ")" ? t[0]!.value.toLowerCase() : undefined;
  const noArgs = t.length === 3 || (t.length === 1 && t[0]!.kind === "word");
  const fn = t.length === 1 && t[0]!.kind === "word" ? t[0]!.value.toLowerCase() : call;
  if (fn && noArgs) {
    if (NOW_FUNCTIONS.has(fn)) {
      if (chType.startsWith("Date32")) return { kind: "function", expr: "today()", source };
      const p = /^DateTime64\((\d)/.exec(chType)?.[1] ?? "3";
      return { kind: "function", expr: `now64(${p})`, source };
    }
    if (fn === "newid" || fn === "newsequentialid") return { kind: "function", expr: "generateUUIDv4()", source };
  }
  return { kind: "untranslated", source };
}

// --- tables ----------------------------------------------------------------------------

interface TableState {
  ast: TableAst;
  display: string;
  constraints: ConstraintAst[];
  indexes: IndexAst[];
  /** Description text from `sp_addextendedproperty`. */
  comment?: string;
  columnComments: Map<string, string>;
}

function columnLookup(ast: TableAst): Map<string, ColumnAst> {
  return new Map(ast.columns.map((c) => [c.name.toLowerCase(), c]));
}

/** The column's declared casing, so a key written in another case still names it. */
function declared(lookup: Map<string, ColumnAst>, name: string): string {
  return lookup.get(name.toLowerCase())?.name ?? name;
}

function keyText(c: ConstraintAst): string {
  return `${c.kind === "primary-key" ? "PRIMARY KEY" : "UNIQUE"}${c.clustered === undefined ? "" : c.clustered ? " CLUSTERED" : " NONCLUSTERED"}${c.name ? ` ${c.name}` : ""}`;
}

function translateTable(state: TableState, report: Report, problems: string[]): ImportedObject | undefined {
  const { ast } = state;
  const object = state.display;
  const lookup = columnLookup(ast);
  const at = ast.loc;
  const columnDefaults = new Map<string, ConstraintAst>();
  const tableConstraints: ConstraintAst[] = [];
  for (const c of state.constraints) {
    if (c.kind === "default") {
      const col = c.columns[0]?.name ?? c.onColumn;
      if (col) columnDefaults.set(col.toLowerCase(), c);
    } else tableConstraints.push(c);
  }
  const primary = tableConstraints.find((c) => c.kind === "primary-key");
  const pkColumns = new Set((primary?.columns ?? []).map((k) => k.name.toLowerCase()));

  const lines: string[] = [];
  const columnTypes: Record<string, string> = {};
  const header: string[] = [];
  const maxLengths = new Map<string, number>();
  let failed = false;

  for (const col of ast.columns) {
    if (col.computed) {
      report.note(
        "SQLRV006",
        "warning",
        object,
        `Computed column ${col.name} is not carried.`,
        [`AS ${oneLine(col.computed.expression)}${col.computed.persisted ? " PERSISTED" : ""}`, "the expression is T-SQL and is not translated"],
        col.loc,
        col.name,
        "Add the column as MATERIALIZED or ALIAS with the expression rewritten in ClickHouse SQL, or compute it in the query.",
      );
      header.push(`-- computed column ${ident(col.name)} AS ${oneLine(col.computed.expression)} is not carried`);
      continue;
    }
    const mapped = mapType(col.type ?? "", col.typeArgs);
    if (!mapped.ok) {
      problems.push(`${object}.${col.name} (line ${String(col.loc.line)}): ${mapped.reason}`);
      failed = true;
      continue;
    }
    if (mapped.note) report.note("SQLRV007", "warning", object, mapped.note.message, mapped.note.evidence, col.loc, col.name);
    if (mapped.maxLength !== undefined) maxLengths.set(col.name, mapped.maxLength);

    const def = translateDefault(columnDefaults.get(col.name.toLowerCase()), mapped.type);
    if (def.kind === "sequence") {
      report.note("SQLRV006", "warning", object, `The default of ${col.name} draws from a sequence, which ClickHouse does not have.`, [`DEFAULT ${def.source}`], col.loc, col.name, "Generate the value in the load, or use generateSerialID('name') in a DEFAULT where one counter per server is enough.");
    } else if (def.kind === "untranslated") {
      report.note("SQLRV008", "warning", object, `The default of ${col.name} is T-SQL and is not carried.`, [`DEFAULT ${def.source}`], col.loc, col.name, "Write the default in ClickHouse SQL.");
    } else if (def.kind === "function") {
      report.note("SQLRV008", "warning", object, `The default of ${col.name} is written as ${def.expr}.`, [`DEFAULT ${def.source}`, "the source function is evaluated in the server's local time or UTC by its name; the ClickHouse function follows the server time zone"], col.loc, col.name);
    }
    if (col.identity) {
      report.note(
        "SQLRV006",
        "warning",
        object,
        `Identity column ${col.name} is a plain column here.`,
        [`IDENTITY(${col.identity.seed}, ${col.identity.increment})`, "ClickHouse has no auto-increment column"],
        col.loc,
        col.name,
        "Load the values from the source, or generate them with generateSerialID or a UUID.",
      );
    }
    if (col.generated) {
      report.note("SQLRV006", "warning", object, `Column ${col.name} is filled by the system in the source.`, [oneLine(col.generated), "ClickHouse does not maintain system-versioning columns"], col.loc, col.name, "Load the values, or give the column a DEFAULT now64().");
    }
    if (col.collate) {
      report.note("SQLRV007", "warning", object, `Collation ${col.collate} on ${col.name} is not carried.`, ["ClickHouse compares String values as bytes; SQL Server collations are usually case-insensitive"], col.loc, col.name);
    }
    for (const extra of [...col.extras, ...(col.sparse ? ["SPARSE"] : []), ...(col.rowguid ? ["ROWGUIDCOL"] : [])]) {
      report.note("SQLRV009", "warning", object, `Column option ${extra} on ${col.name} is not carried.`, [extra], col.loc, col.name);
    }

    // Nullability: a primary key column and an identity column are NOT NULL; the default for others is NULL.
    const sourceNullable = col.nullable ?? (!pkColumns.has(col.name.toLowerCase()) && !col.identity);
    const forcedNotNull = pkColumns.has(col.name.toLowerCase()) || !!col.identity;
    const nullable = forcedNotNull ? false : sourceNullable;
    const defaultText = def.expr ?? (def.kind === "untranslated" ? def.source : undefined);
    const n = nullableReview({ object, column: col.name, type: mapped.type, sourceNullable: nullable, ...(defaultText !== undefined ? { defaultExpr: defaultText } : {}), at: col.loc });
    if (n.finding) report.finding(n.finding);
    columnTypes[col.name] = n.type;
    const lc = lowCardinalityReview({ object, column: col.name, type: n.type, ...(mapped.maxLength !== undefined ? { maxLength: mapped.maxLength } : {}), at: col.loc });
    if (lc) report.finding(lc);

    const comment = state.columnComments.get(col.name.toLowerCase());
    lines.push(`    ${ident(col.name)} ${n.type}${def.expr !== undefined ? ` DEFAULT ${def.expr}` : ""}${comment ? ` COMMENT ${chString(comment)}` : ""}`);
  }
  if (failed) return undefined;
  if (lines.length === 0) {
    problems.push(`${object} (line ${String(at.line)}): the table has no column that can be carried`);
    return undefined;
  }

  // Indexes: the clustered rowstore index, the clustered columnstore index, the rest.
  const cci = state.indexes.find((i) => i.columnstore && i.clustered);
  const explicitClustered = state.indexes.find((i) => !i.columnstore && i.clustered);
  const clusteredConstraint = tableConstraints.find((c) => (c.kind === "primary-key" || c.kind === "unique") && c.clustered === true);
  // A primary key is clustered unless the table has another clustered structure or says NONCLUSTERED.
  const impliedClusteredPk = primary && primary.clustered === undefined && !cci && !explicitClustered && !clusteredConstraint ? primary : undefined;

  const candidates: SortKeyCandidate[] = [];
  if (cci && cci.order.length > 0) {
    candidates.push({ kind: "explicit-order", name: cci.name, columns: cci.order.map((c) => declared(lookup, c)), source: `CREATE CLUSTERED COLUMNSTORE INDEX ${cci.name} ORDER` });
  }
  if (explicitClustered) {
    candidates.push({
      kind: "clustering-key",
      name: explicitClustered.name,
      columns: explicitClustered.columns.map((k) => declared(lookup, k.name)),
      descending: explicitClustered.columns.filter((k) => k.descending).map((k) => declared(lookup, k.name)),
      source: `CREATE ${explicitClustered.unique ? "UNIQUE " : ""}CLUSTERED INDEX ${explicitClustered.name}`,
    });
  }
  const clusteringConstraint = clusteredConstraint ?? impliedClusteredPk;
  if (clusteringConstraint) {
    candidates.push({
      kind: "clustering-key",
      name: clusteringConstraint.name,
      columns: clusteringConstraint.columns.map((k) => declared(lookup, k.name)),
      descending: clusteringConstraint.columns.filter((k) => k.descending).map((k) => declared(lookup, k.name)),
      source: `${keyText(clusteringConstraint)}${clusteringConstraint === impliedClusteredPk ? " (clustered because the table has no other clustered index)" : ""}`,
    });
  }
  if (primary && primary !== clusteringConstraint) {
    candidates.push({ kind: "primary-key", name: primary.name, columns: primary.columns.map((k) => declared(lookup, k.name)), descending: primary.columns.filter((k) => k.descending).map((k) => declared(lookup, k.name)), source: keyText(primary) });
  }
  const firstUnique = tableConstraints.find((c) => c.kind === "unique" && c !== clusteringConstraint) ?? undefined;
  const uniqueIndex = state.indexes.find((i) => i.unique && !i.columnstore && !i.clustered);
  if (firstUnique) candidates.push({ kind: "unique-key", name: firstUnique.name, columns: firstUnique.columns.map((k) => declared(lookup, k.name)), source: keyText(firstUnique) });
  else if (uniqueIndex) candidates.push({ kind: "unique-key", name: uniqueIndex.name, columns: uniqueIndex.columns.map((k) => declared(lookup, k.name)), source: `CREATE UNIQUE INDEX ${uniqueIndex.name}` });

  // A key that names a column this source did not carry (a computed column) cannot be used.
  const usable = candidates.filter((c) => c.columns.every((n) => n in columnTypes));
  const sortKey = sortKeyReview({ object, candidates: usable, columnTypes, at });
  const unusable = candidates.filter((c) => !usable.includes(c));
  const extraEvidence = [
    ...unusable.map((c) => `passed over: ${c.source} (${c.columns.join(", ")}) names a column that is not carried`),
    ...(cci && cci.order.length === 0 ? [`CREATE CLUSTERED COLUMNSTORE INDEX ${cci.name} has no ORDER clause, so it names no key`] : []),
  ];
  if (extraEvidence.length > 0) sortKey.finding = { ...sortKey.finding, evidence: [...sortKey.finding.evidence, ...extraEvidence] };
  report.finding(sortKey.finding);

  const uniqueFacts = primary ? primary.columns.map((k) => declared(lookup, k.name)) : undefined;
  const engine = engineReview({
    object,
    mode: "append",
    facts: [
      ...(cci ? [`${cci.name} is a clustered columnstore index, which stores the table by column as MergeTree does`] : []),
      ...(!cci ? ["the table is a rowstore table, read here as an append-only analytical table"] : []),
    ],
    ...(uniqueFacts ? { uniqueKey: uniqueFacts } : {}),
    at,
  });
  report.finding(engine.finding);

  // Constraints ClickHouse does not enforce.
  const facts: ConstraintFact[] = [];
  for (const c of tableConstraints) {
    if (c.kind === "foreign-key") {
      facts.push({ kind: "foreign-key", ...(c.name ? { name: c.name } : {}), columns: c.columns.map((k) => declared(lookup, k.name)), ...(c.references ? { references: { table: c.references.table.parts.join("."), columns: c.references.columns } } : {}), at: c.loc });
    } else if (c.kind === "check") {
      facts.push({ kind: "check", ...(c.name ? { name: c.name } : {}), ...(c.expression ? { expression: c.expression } : {}), at: c.loc });
    } else if (c.kind === "unique") {
      facts.push({ kind: "unique", ...(c.name ? { name: c.name } : {}), columns: c.columns.map((k) => declared(lookup, k.name)), at: c.loc });
    }
  }
  for (const i of state.indexes) {
    if (i.unique && !i.columnstore) facts.push({ kind: "unique", name: i.name, columns: i.columns.map((k) => declared(lookup, k.name)), at: i.loc });
  }
  const constraintOut = constraintReview({ object, constraints: facts });
  for (const f of constraintOut.findings) report.finding(f);

  // Storage options and indexes that nothing carries.
  const dropped: string[] = [];
  for (const o of ast.options) dropped.push(oneLine(o));
  if (ast.period) dropped.push(`PERIOD FOR SYSTEM_TIME (${ast.period.start}, ${ast.period.end})`);
  for (const c of tableConstraints) for (const o of c.kind === "foreign-key" ? [] : c.options) dropped.push(`${keyText(c)} ${oneLine(o)}`);
  for (const i of state.indexes) for (const o of i.options) dropped.push(`${i.name} ${oneLine(o)}`);
  if (dropped.length > 0) {
    report.note(
      "SQLRV009",
      "warning",
      object,
      "Storage options of the source table are not carried.",
      dropped,
      at,
      undefined,
      "Map partitioning to PARTITION BY and compression to column CODECs after the first load, once you know how the table is queried.",
    );
  }
  for (const i of state.indexes) {
    if (i.columnstore && i.clustered) continue;
    if (i.clustered) continue;
    const what = i.columnstore ? "nonclustered columnstore index" : i.unique ? "unique index" : "nonclustered index";
    report.note(
      "SQLRV009",
      "warning",
      object,
      `${i.name}, a ${what} on (${i.columns.map((k) => declared(lookup, k.name)).join(", ")}), is not carried.`,
      [`CREATE ${i.unique ? "UNIQUE " : ""}${i.columnstore ? "COLUMNSTORE " : ""}INDEX ${i.name}${i.where ? ` WHERE ${oneLine(i.where)}` : ""}${i.include.length ? ` INCLUDE (${i.include.join(", ")})` : ""}`],
      i.loc,
      undefined,
      i.columnstore ? "A MergeTree table is already stored by column." : "ClickHouse has no secondary index of this kind. A skip index (minmax, set, bloom_filter) on the column can prune granules.",
    );
  }

  const engineText = engine.engine;
  const extra = engine.extraColumns.map((c) => `    ${c.name} ${c.type}`);
  const settings = Object.entries(sortKey.settings).map(([k, v]) => `${k} = ${v}`);
  const ddl = [
    ...constraintOut.comments,
    ...header,
    `CREATE TABLE ${qualified(ast.name)}`,
    "(",
    [...lines, ...extra].join(",\n"),
    ")",
    `ENGINE = ${engineText}`,
    `ORDER BY ${sortKey.orderBy.length === 0 ? "tuple()" : sortKey.orderBy.length === 1 ? ident(sortKey.orderBy[0]!) : `(${sortKey.orderBy.map(ident).join(", ")})`}`,
    ...(settings.length > 0 ? [`SETTINGS ${settings.join(", ")}`] : []),
    ...(state.comment ? [`COMMENT ${chString(state.comment)}`] : []),
  ].join("\n");
  return { type: CLICKHOUSE_ENTITY_TYPES.table, ...(databaseOf(ast.name) ? { database: databaseOf(ast.name)! } : {}), name: nameOf(ast.name), ddl };
}

// --- views -----------------------------------------------------------------------------

const TSQL_ONLY = new Set(
  "TOP ISNULL GETDATE GETUTCDATE SYSDATETIME SYSUTCDATETIME CONVERT LEN CHARINDEX DATEADD DATEDIFF DATEPART DATENAME NEWID STUFF STRING_AGG APPLY NOLOCK FORMAT OFFSET FETCH PIVOT UNPIVOT ROWLOCK READPAST UPDLOCK TABLESAMPLE OPENJSON OPENXML CROSS OUTER".split(" "),
);

function translateView(v: ViewAst, report: Report): ImportedObject {
  const object = display(v.name);
  const toks = v.bodyTokens;
  const base = toks[0]?.start ?? 0;
  let body = "";
  let prevEnd = base;
  let dropDot = false;
  const found = new Set<string>();
  toks.forEach((t, i) => {
    const gap = v.body.slice(prevEnd - base, t.start - base);
    prevEnd = t.end;
    if (dropDot) {
      // The dot after a dropped `dbo`.
      dropDot = false;
      return;
    }
    let text = t.text;
    const next = toks[i + 1];
    if (t.kind === "string") text = chString(t.value);
    else if (t.kind === "word" || t.kind === "qident") {
      if (t.kind === "qident") text = ident(t.value);
      if (t.kind === "word" && TSQL_ONLY.has(t.value.toUpperCase())) found.add(t.value.toUpperCase());
      // `dbo.Orders`: the default schema is dropped from names.
      if (t.value.toLowerCase() === DEFAULT_SCHEMA && next && next.kind === "punct" && next.value === "." && next.start === t.end) {
        dropDot = true;
        body += gap;
        return;
      }
    }
    body += gap + text;
  });
  const evidence = ["the body is copied as written, with identifiers requoted and the dbo schema dropped"];
  evidence.push(found.size > 0 ? `T-SQL constructs found by name: ${[...found].sort().join(", ")}` : "no T-SQL-only construct was found by name, but the server checks every function and type when the view is created");
  if (v.columns.length > 0) evidence.push(`the column list (${v.columns.join(", ")}) is not carried; alias the columns in the SELECT`);
  if (v.options.length > 0) evidence.push(`view options not carried: ${v.options.map(oneLine).join(", ")}`);
  report.note("SQLRV010", "warning", object, "The view's query is not translated.", evidence, v.loc, undefined, "Rewrite the query in ClickHouse SQL. ClickHouse names are case-sensitive, and a T-SQL function, TOP or an unqualified join key may need a different form.");
  const ddl = `CREATE VIEW ${qualified(v.name)} AS\n${body.trim()}`;
  return { type: CLICKHOUSE_ENTITY_TYPES.view, ...(databaseOf(v.name) ? { database: databaseOf(v.name)! } : {}), name: nameOf(v.name), ddl };
}

// --- the file --------------------------------------------------------------------------

export function translateSqlServer(text: string, options: TranslateOptions = {}): Translation {
  const report = new Report();
  const problems: string[] = [];
  const parsed = parseTsql(text);

  const tables = new Map<string, TableState>();
  const order: Array<TableState | ViewAst> = [];
  const schemas = new Map<string, { name: string; loc: Loc }>();
  const views: ViewAst[] = [];
  const pendingIndexes: IndexAst[] = [];
  const pendingConstraints: AlterConstraintAst[] = [];
  const pendingProperties: Array<(typeof parsed.statements)[number] & { kind: "extended-property" }> = [];

  for (const s of parsed.statements) {
    switch (s.kind) {
      case "table": {
        const st: TableState = { ast: s, display: display(s.name), constraints: [...s.constraints], indexes: [...s.indexes], columnComments: new Map() };
        tables.set(keyOf(s.name), st);
        order.push(st);
        break;
      }
      case "view":
        views.push(s);
        order.push(s);
        break;
      case "index":
        pendingIndexes.push(s);
        break;
      case "alter-constraint":
        pendingConstraints.push(s);
        break;
      case "schema":
        schemas.set(s.name.toLowerCase(), { name: s.name, loc: s.loc });
        break;
      case "extended-property":
        pendingProperties.push(s);
        break;
      case "refused":
        problems.push(`${s.objectKind}${s.name ? ` ${s.name}` : ""} (line ${String(s.loc.line)}): ${s.reason}`);
        break;
      case "ignored":
        report.note("SQLRV011", "info", s.text, `Not carried: ${s.reason}.`, [s.text], s.loc);
        break;
    }
  }
  for (const u of parsed.unread) problems.push(`${u.text} (line ${String(u.loc.line)}): ${u.reason}`);

  for (const ix of pendingIndexes) {
    const target = ix.table ? tables.get(keyOf(ix.table)) : undefined;
    if (!target) {
      const isView = ix.table && views.some((v) => keyOf(v.name) === keyOf(ix.table!));
      problems.push(`index ${ix.name} (line ${String(ix.loc.line)}): ${isView ? "an index on a view; ClickHouse has no indexed views" : `the table ${ix.table ? ix.table.parts.join(".") : ""} is not created in this file`}`);
      continue;
    }
    target.indexes.push(ix);
  }
  for (const a of pendingConstraints) {
    const target = tables.get(keyOf(a.table));
    if (!target) {
      problems.push(`ALTER TABLE ${a.table.parts.join(".")} ADD CONSTRAINT${a.constraint.name ? ` ${a.constraint.name}` : ""} (line ${String(a.loc.line)}): the table is not created in this file`);
      continue;
    }
    target.constraints.push(a.constraint);
  }
  for (const p of pendingProperties) {
    const target = p.schema && p.table ? tables.get(`${p.schema}.${p.table}`.toLowerCase()) : undefined;
    const isDescription = p.property.toLowerCase() === "description" || p.property.toLowerCase() === "ms_description";
    if (target && isDescription && !p.level2 && p.level1Type?.toUpperCase() === "TABLE") {
      if (p.column) {
        if (target.ast.columns.some((c) => c.name.toLowerCase() === p.column!.toLowerCase())) target.columnComments.set(p.column.toLowerCase(), p.value);
        else report.note("SQLRV011", "info", target.display, `The description of column ${p.column} names no column of the table.`, [p.value], p.loc);
      } else target.comment = p.value;
    } else {
      report.note("SQLRV011", "info", p.table ? `${p.schema ?? ""}.${p.table}`.replace(/^\./, "") : "extended property", `Extended property ${p.property} is not carried.`, [`${p.property} = ${p.value}${p.level2 ? ` on ${p.level2.type} ${p.level2.name}` : ""}`, "only a Description on a table or column becomes a ClickHouse COMMENT"], p.loc);
    }
  }

  // Databases: one per schema other than dbo, in the order the file first names them.
  const databases = new Map<string, { name: string; explicit: boolean; loc: Loc }>();
  for (const [lower, sc] of schemas) databases.set(lower, { name: sc.name, explicit: true, loc: sc.loc });
  for (const e of order) {
    const q = "ast" in e ? e.ast.name : e.name;
    const db = databaseOf(q);
    if (db && !databases.has(db.toLowerCase())) databases.set(db.toLowerCase(), { name: db, explicit: false, loc: q.loc });
  }
  const objects: ImportedObject[] = [];
  for (const [lower, d] of databases) {
    if (lower === DEFAULT_SCHEMA) continue;
    if (!d.explicit) report.note("SQLRV011", "info", d.name, `Schema ${d.name} becomes the database ${d.name}.`, ["the file creates no schema of that name, but a table or view lives in it"], d.loc);
    objects.push({ type: CLICKHOUSE_ENTITY_TYPES.database, name: d.name, ddl: `CREATE DATABASE ${ident(d.name)}` });
  }

  for (const e of order) {
    if ("ast" in e) {
      const o = translateTable(e, report, problems);
      if (o) objects.push(o);
    } else {
      objects.push(translateView(e, report));
    }
  }

  // Refusals: a failure, or listed when the caller skips what it cannot read.
  const diagnostics = [...report.diagnostics];
  if (options.skipUnreadable) {
    for (const p of problems.splice(0)) diagnostics.push({ ruleId: "SQLRV011", severity: "warning", message: `Left out (skipUndeclarable): ${p}` });
  }
  return { objects, diagnostics: sortDiagnostics(diagnostics), problems };
}

function sortDiagnostics(d: ImportDiagnostic[]): ImportDiagnostic[] {
  return d
    .map((x, i) => [x, i] as const)
    .sort(([a, i], [b, j]) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.column ?? 0) - (b.column ?? 0) || i - j)
    .map(([x]) => x);
}
