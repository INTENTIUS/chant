/**
 * The classified changes between what a MySQL server holds and what a build
 * declares (#5449), each with the statement clause that makes it.
 *
 * Objects match by key (`table shop.users`), then by a `-- previously:`
 * hint, the shared core's identity rules (`../../core/diff.ts`). Inside a
 * matched table, columns, indexes, foreign keys and checks match by name,
 * case-insensitively, as MySQL compares them. What the declaration does not
 * say is not compared (`../canonical.ts`).
 *
 * A table's changes become at most three statements, in order: a `RENAME
 * TABLE`, an `ALTER TABLE` that drops the foreign keys and checks that change
 * or go (MySQL cannot drop and add a constraint of one name in one
 * statement), and one `ALTER TABLE` with every other clause, which MySQL runs
 * as one operation. A view's change is `CREATE OR REPLACE VIEW`; a database's
 * is `ALTER DATABASE`.
 */

import { classifiedChange, type ChangeSet, type ClassifiedChange } from "../../core/classifier";
import { matchByIdentity, type Keyed } from "../../core/diff";
import { mysqlString, quoteIdent } from "../names";
import type { CanonicalColumn, CanonicalDatabase, CanonicalObject, CanonicalTable, CanonicalView } from "../canonical";
import { MYSQL_CLASSIFIER_RULES, type MysqlChangeClass, type MysqlClassifierRuleId } from "./rules";

export type MysqlChange = ClassifiedChange<MysqlClassifierRuleId, MysqlChangeClass>;

export interface MysqlSchemaDiff extends ChangeSet<MysqlChange> {}

/** The statements one object's changes take, in order. */
export interface ObjectStatements {
  key: string;
  /** Statements before the main one: a rename, then the constraint drops. */
  before: string[];
  /** Clauses of the one `ALTER TABLE` (or the whole statement for a view or a database). */
  clauses: string[];
  /** A whole statement in place of `clauses`: a view's `CREATE OR REPLACE`, a database's `ALTER DATABASE`. */
  statement?: string;
}

const change = (object: string, field: string, rule: MysqlClassifierRuleId, before?: unknown, after?: unknown, extra: Partial<MysqlChange> = {}): MysqlChange =>
  classifiedChange(MYSQL_CLASSIFIER_RULES, object, field, rule, before, after, extra);

const lower = (s: string) => s.toLowerCase();
const byName = <T extends { name: string }>(items: readonly T[]): Map<string, T> => new Map(items.map((i) => [lower(i.name), i]));

const tableName = (t: { database?: string; name: string }) => (t.database ? `${quoteIdent(t.database)}.${quoteIdent(t.name)}` : quoteIdent(t.name));

/** The identity rules for MySQL: a hint names an object in the same database, or `db.name`. */
const IDENTITY = {
  qualified: (o: CanonicalObject) => `${o.kind} ${o.database ? `${o.database}.` : ""}${o.name}`,
  previously: (o: CanonicalObject) => o.previously,
  previousNames: (o: CanonicalObject, prev: string) => [`${o.kind} ${prev}`, ...(o.database && !prev.includes(".") ? [`${o.kind} ${o.database}.${prev}`] : [])],
};

/**
 * The changes from `live` to `declared`. A live object the build does not
 * declare is a `drop` change only when `droppable` says so (a table that
 * carries chant's marker); the rest are left out, since an apply never
 * touches them.
 */
export function diffMysqlSchemas(
  live: readonly Keyed<CanonicalObject>[],
  declared: readonly Keyed<CanonicalObject>[],
  options: { droppable?: (o: Keyed<CanonicalObject>) => boolean } = {},
): MysqlSchemaDiff & { statements: Map<string, ObjectStatements> } {
  const changes: MysqlChange[] = [];
  const hints: string[] = [];
  const statements = new Map<string, ObjectStatements>();
  for (const m of matchByIdentity(live, declared, IDENTITY)) {
    if (m.kind === "created") {
      changes.push(change(m.after.key, "object", "SQLMY200", undefined, m.after.canonical.kind));
      continue;
    }
    if (m.kind === "dropped") {
      if (options.droppable?.(m.before)) changes.push(change(m.before.key, "object", "SQLMY224", m.before.canonical.kind, undefined, { destructive: m.before.canonical.kind === "table" }));
      continue;
    }
    const before = m.before.canonical;
    const after = m.after.canonical;
    const out: ObjectStatements = { key: m.after.key, before: [], clauses: [] };
    if (before.kind === "table" && after.kind === "table") diffTable(m.after.key, before, after, changes, out);
    else if (before.kind === "view" && after.kind === "view") diffView(m.after.key, before, after, changes, out);
    else if (before.kind === "database" && after.kind === "database") diffDatabase(m.after.key, before, after, changes, out);
    if (out.before.length > 0 || out.clauses.length > 0 || out.statement) statements.set(m.after.key, out);
  }
  // A dropped column beside an added one of the same type reads like a rename, which MySQL would do in place.
  const byObject = new Map<string, MysqlChange[]>();
  for (const c of changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  for (const [object, list] of byObject) {
    const dropped = list.filter((c) => c.rule === "SQLMY203");
    const added = list.filter((c) => c.rule === "SQLMY201");
    if (dropped.length > 0 && added.length > 0) {
      hints.push(`${object}: ${dropped.map((c) => c.field.replace(/^columns\./, "")).join(", ")} dropped and ${added.map((c) => c.field.replace(/^columns\./, "")).join(", ")} added; a rename keeps the data, and chant plans it as a drop and an add`);
    }
  }
  return { changes, hints, statements };
}

function diffDatabase(key: string, l: CanonicalDatabase, d: CanonicalDatabase, changes: MysqlChange[], out: ObjectStatements): void {
  const set: string[] = [];
  if (d.charset !== undefined && d.charset !== l.charset) {
    changes.push(change(key, "charset", "SQLMY223", l.charset, d.charset));
    set.push(`CHARACTER SET ${d.charset}`);
  }
  if (d.collate !== undefined && d.collate !== l.collate) {
    changes.push(change(key, "collate", "SQLMY223", l.collate, d.collate));
    set.push(`COLLATE ${d.collate}`);
  }
  if (set.length > 0) out.statement = `ALTER DATABASE ${quoteIdent(d.name)} ${set.join(" ")}`;
}

function diffView(key: string, l: CanonicalView, d: CanonicalView, changes: MysqlChange[], _out: ObjectStatements): void {
  if (d.query !== l.query) changes.push(change(key, "query", "SQLMY222", l.query, d.query));
  if (d.columns.length > 0 && d.columns.join(",") !== l.columns.join(",")) changes.push(change(key, "columns", "SQLMY222", l.columns.join(", "), d.columns.join(", ")));
  if (d.algorithm !== undefined && d.algorithm !== l.algorithm) changes.push(change(key, "algorithm", "SQLMY222", l.algorithm, d.algorithm));
  if (d.security !== undefined && d.security !== l.security) changes.push(change(key, "security", "SQLMY222", l.security, d.security));
  if ((d.checkOption ?? "") !== (l.checkOption ?? "")) changes.push(change(key, "checkOption", "SQLMY222", l.checkOption, d.checkOption));
  // The statement is the declaration's own, written as CREATE OR REPLACE by the applier.
}

/** A column's fields compared after the table's defaults are applied to both sides. */
function columnChanges(key: string, table: { charset?: string; collate?: string }, l: CanonicalColumn, d: CanonicalColumn): MysqlChange[] {
  const out: MysqlChange[] = [];
  const field = (f: string) => `columns.${d.name}.${f}`;
  if (d.type !== l.type) out.push(change(key, field("type"), "SQLMY204", l.type, d.type));
  if (d.nullable !== l.nullable) out.push(change(key, field("nullable"), "SQLMY206", l.nullable ? "NULL" : "NOT NULL", d.nullable ? "NULL" : "NOT NULL"));
  if ((d.default ?? "") !== (l.default ?? "")) out.push(change(key, field("default"), "SQLMY205", l.default, d.default));
  const own = (v: string | undefined, tableValue: string | undefined) => (v !== undefined && v !== tableValue ? v : undefined);
  const dCharset = own(d.charset, table.charset);
  const dCollate = own(d.collate, table.collate);
  if (dCharset !== undefined && dCharset !== own(l.charset, table.charset)) out.push(change(key, field("charset"), "SQLMY208", l.charset, d.charset));
  if (dCollate !== undefined && dCollate !== own(l.collate, table.collate)) out.push(change(key, field("collate"), "SQLMY208", l.collate, d.collate));
  if ((d.generated ?? "") !== (l.generated ?? "")) out.push(change(key, field("generated"), "SQLMY204", l.generated, d.generated));
  for (const f of ["onUpdate", "comment", "srid"] as const) {
    if ((d[f] ?? "") !== (l[f] ?? "")) out.push(change(key, field(f), "SQLMY207", l[f], d[f]));
  }
  if (d.autoIncrement !== l.autoIncrement) out.push(change(key, field("autoIncrement"), "SQLMY207", l.autoIncrement, d.autoIncrement));
  if (d.invisible !== l.invisible) out.push(change(key, field("invisible"), "SQLMY207", l.invisible ? "INVISIBLE" : "VISIBLE", d.invisible ? "INVISIBLE" : "VISIBLE"));
  return out;
}

function diffTable(key: string, l: CanonicalTable, d: CanonicalTable, changes: MysqlChange[], out: ObjectStatements): void {
  if (l.name !== d.name || l.database !== d.database) {
    changes.push(change(key, "name", "SQLMY221", `${l.database}.${l.name}`, `${d.database}.${d.name}`));
    out.before.push(`RENAME TABLE ${tableName(l)} TO ${tableName(d)}`);
  }
  // The table's effective defaults: the declaration's where it says, else the server's.
  const defaults = { charset: d.charset ?? l.charset, collate: d.collate ?? l.collate };

  // Columns.
  const liveColumns = byName(l.columns);
  const declaredColumns = byName(d.columns);
  for (const c of d.columns) {
    const lc = liveColumns.get(lower(c.name));
    if (!lc) {
      const stored = c.autoIncrement || (c.generated?.endsWith(" STORED") ?? false);
      changes.push(change(key, `columns.${c.name}`, stored ? "SQLMY202" : "SQLMY201", undefined, c.type));
      out.clauses.push(`ADD COLUMN ${c.definition}`);
      continue;
    }
    const cc = columnChanges(key, defaults, lc, c);
    if (cc.length === 0) continue;
    changes.push(...cc);
    if (cc.every((x) => x.rule === "SQLMY205")) out.clauses.push(c.default !== undefined ? `ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${columnDefault(c)}` : `ALTER COLUMN ${quoteIdent(c.name)} DROP DEFAULT`);
    else out.clauses.push(`MODIFY COLUMN ${c.definition}`);
  }
  for (const lc of l.columns) {
    if (declaredColumns.has(lower(lc.name))) continue;
    changes.push(change(key, `columns.${lc.name}`, "SQLMY203", lc.type, undefined, { destructive: true }));
    out.clauses.push(`DROP COLUMN ${quoteIdent(lc.name)}`);
  }

  // The primary key.
  if ((d.primaryKey ?? "") !== (l.primaryKey ?? "")) {
    changes.push(change(key, "primaryKey", "SQLMY212", l.primaryKey, d.primaryKey));
    if (l.primaryKey !== undefined) out.clauses.push("DROP PRIMARY KEY");
    if (d.primaryKeySql !== undefined) out.clauses.push(`ADD PRIMARY KEY ${d.primaryKeySql}`);
  }

  // Secondary indexes.
  const liveIndexes = byName(l.indexes);
  const declaredIndexes = byName(d.indexes);
  for (const i of d.indexes) {
    const li = liveIndexes.get(lower(i.name));
    if (!li) {
      changes.push(change(key, `indexes.${i.name}`, "SQLMY209", undefined, `${i.kind} (${i.parts})`));
      out.clauses.push(`ADD ${i.definition}`);
      continue;
    }
    const differs = li.kind !== i.kind || li.parts !== i.parts || li.comment !== i.comment || (i.using !== undefined && i.using !== li.using);
    if (differs) {
      changes.push(change(key, `indexes.${i.name}`, "SQLMY209", `${li.kind} (${li.parts})`, `${i.kind} (${i.parts})`));
      out.clauses.push(`DROP INDEX ${quoteIdent(li.name)}`, `ADD ${i.definition}`);
    } else if (li.invisible !== i.invisible) {
      changes.push(change(key, `indexes.${i.name}.invisible`, "SQLMY211", li.invisible ? "INVISIBLE" : "VISIBLE", i.invisible ? "INVISIBLE" : "VISIBLE"));
      out.clauses.push(`ALTER INDEX ${quoteIdent(i.name)} ${i.invisible ? "INVISIBLE" : "VISIBLE"}`);
    }
  }
  for (const li of l.indexes) {
    if (declaredIndexes.has(lower(li.name))) continue;
    changes.push(change(key, `indexes.${li.name}`, "SQLMY210", `${li.kind} (${li.parts})`, undefined));
    out.clauses.push(`DROP INDEX ${quoteIdent(li.name)}`);
  }

  // Foreign keys: a changed one is dropped in its own statement first, then added.
  const liveFks = byName(l.foreignKeys);
  const declaredFks = byName(d.foreignKeys);
  const drops: string[] = [];
  for (const f of d.foreignKeys) {
    const lf = liveFks.get(lower(f.name));
    const describe = (x: typeof f) => `(${x.columns}) -> ${x.references} (${x.refColumns}) ON DELETE ${x.onDelete} ON UPDATE ${x.onUpdate}`;
    if (lf && describe(lf).toLowerCase() === describe(f).toLowerCase()) continue;
    changes.push(change(key, `foreignKeys.${f.name}`, "SQLMY213", lf ? describe(lf) : undefined, describe(f)));
    if (lf) drops.push(`DROP FOREIGN KEY ${quoteIdent(lf.name)}`);
    out.clauses.push(`ADD ${f.definition}`);
  }
  for (const lf of l.foreignKeys) {
    if (declaredFks.has(lower(lf.name))) continue;
    changes.push(change(key, `foreignKeys.${lf.name}`, "SQLMY214", `(${lf.columns}) -> ${lf.references} (${lf.refColumns})`, undefined));
    drops.push(`DROP FOREIGN KEY ${quoteIdent(lf.name)}`);
  }

  // Checks.
  const liveChecks = byName(l.checks);
  const declaredChecks = byName(d.checks);
  for (const c of d.checks) {
    const lc = liveChecks.get(lower(c.name));
    if (lc && lc.expr === c.expr) {
      if (lc.enforced !== c.enforced) {
        changes.push(change(key, `checks.${c.name}.enforced`, c.enforced ? "SQLMY215" : "SQLMY216", lc.enforced ? "ENFORCED" : "NOT ENFORCED", c.enforced ? "ENFORCED" : "NOT ENFORCED"));
        out.clauses.push(`ALTER CHECK ${quoteIdent(c.name)} ${c.enforced ? "ENFORCED" : "NOT ENFORCED"}`);
      }
      continue;
    }
    changes.push(change(key, `checks.${c.name}`, "SQLMY215", lc?.expr, c.expr));
    if (lc) drops.push(`DROP CHECK ${quoteIdent(lc.name)}`);
    out.clauses.push(`ADD ${c.definition}`);
  }
  for (const lc of l.checks) {
    if (declaredChecks.has(lower(lc.name))) continue;
    changes.push(change(key, `checks.${lc.name}`, "SQLMY216", lc.expr, undefined));
    drops.push(`DROP CHECK ${quoteIdent(lc.name)}`);
  }
  if (drops.length > 0) out.before.push(`ALTER TABLE ${tableName(d)} ${drops.join(", ")}`);

  // Table options, where declared.
  if (d.comment !== l.comment) {
    changes.push(change(key, "comment", "SQLMY217", l.comment, d.comment));
    // The applier writes the comment with the ownership trailer (`../apply/apply.ts`).
    out.clauses.push(`COMMENT = ${mysqlString(d.comment)}`);
  }
  if (d.engine !== undefined && d.engine.toLowerCase() !== (l.engine ?? "").toLowerCase()) {
    changes.push(change(key, "engine", "SQLMY218", l.engine, d.engine));
    out.clauses.push(`ENGINE = ${d.engine}`);
  }
  if (d.charset !== undefined && d.charset !== l.charset) {
    changes.push(change(key, "charset", "SQLMY219", l.charset, d.charset));
    out.clauses.push(`DEFAULT CHARACTER SET = ${d.charset}`);
  }
  if (d.collate !== undefined && d.collate !== l.collate) {
    changes.push(change(key, "collate", "SQLMY219", l.collate, d.collate));
    out.clauses.push(`DEFAULT COLLATE = ${d.collate}`);
  }
  if (d.rowFormat !== undefined && d.rowFormat !== l.rowFormat) {
    changes.push(change(key, "rowFormat", "SQLMY220", l.rowFormat, d.rowFormat));
    out.clauses.push(`ROW_FORMAT = ${d.rowFormat}`);
  }
  for (const [option, value] of Object.entries(d.options)) {
    if ((l.options[option] ?? "").toLowerCase() === value.toLowerCase()) continue;
    changes.push(change(key, `options.${option}`, "SQLMY220", l.options[option], value));
    out.clauses.push(`${option} = ${/^[A-Za-z0-9_]+$/.test(value) ? value : mysqlString(value)}`);
  }
}

/** A column's default as the declaration wrote it, for `SET DEFAULT`. */
const columnDefault = (c: CanonicalColumn): string => c.defaultSql ?? c.default ?? "NULL";
