/**
 * The statements that make one classified Postgres change (#3280): the
 * declared `CREATE` with chant's marker set by `COMMENT ON`, the `ALTER` for
 * each change the classifier (`../plan/rules.ts`) does not refuse, and the
 * `DROP` a prune issues.
 *
 * Each function takes a declared object, what the server holds for it, and
 * the changes the diff reported, and returns statements; nothing is sent. The
 * applier (`./apply.ts`) groups them into transactions and sends them, and
 * the expand-and-contract migration Op (#3281) builds its expand and contract
 * steps from the same pieces.
 *
 * The SQL is the declaration's own text wherever there is some: a column's
 * type and default, a constraint's expression, an index's `CREATE`, a view's
 * `CREATE`. The canonical forms the diff compared are for comparing; what the
 * server is sent is what the author wrote.
 *
 * Every step carries the class of the change it makes, which picks its
 * transaction and its statement timeout, and whether it may run inside a
 * transaction block at all (`CREATE INDEX CONCURRENTLY` may not).
 */

import { createHash } from "node:crypto";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import { stampedComment } from "../../core/ownership";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseStatements, type CommentNode } from "../parser";
import { quoteIdent } from "../keywords";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "../entity-types";
import { addConstraintRule, matchPgObjects } from "../plan/diff";
import type { PgChange } from "../plan/diff";
import { PG_CLASSIFIER_RULES, type PgChangeClass, type PgClassifierRuleId } from "../plan/rules";
import { ACCESS_KINDS, canonicalOptions, sameConstraint, type CanonicalConstraint, type CanonicalKind } from "../plan/normalize";
import type { PgDiffObject, PgSchemaObject } from "../plan/schema";
import { migrationTarget } from "../migrate/handoff";
import { pgName } from "../migrate/names";
import type { CheckDef, ColumnDef, DomainProps, ExclusionDef, ForeignKeyDef, IndexProps, KeyDef, PolicyProps, SequenceProps, TableProps } from "../entities";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One object as a build declares it, in the shape the applier works with. */
export interface DeclaredPgObject {
  /** The export name: the object's identity in chant. */
  exportName: string;
  type: PostgresEntityType;
  /** Its name on the server, as an apply result names it: `app.users`, or a schema's or extension's own name. */
  name: string;
  /** The diff's key against a server: the namespace and the qualified name (`relation app.users`). */
  key: string;
  /** The statements as the build wrote them: the CREATE, then any COMMENT ON. */
  ddl: string;
  /** The props the tag parses out of `ddl`. */
  props: Record<string, unknown>;
  /** The canonical form the diff compares. */
  canonical: PgDiffObject;
  /** The export names it references. */
  dependsOn: string[];
}

/** One statement to send. */
export interface PgStep {
  sql: string;
  /** The class of the change it makes; it picks the transaction and the statement timeout. */
  class: PgChangeClass;
  /** False for a statement that refuses a transaction block or is kept out of one (`CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`). */
  transactional: boolean;
  /** The rule of the change it makes, when it makes one. */
  rule?: PgClassifierRuleId;
  /** An index this statement builds CONCURRENTLY: a failed build leaves it INVALID, and the applier drops it again. */
  buildsIndex?: string;
  /** A query to run before the statement, whose success depends on the rows already in the table (#3686). */
  precheck?: PgPrecheck;
}

/**
 * A data-dependent statement's pre-check (#3686): a query that returns one
 * row with one column, `n`, the count of rows (or groups of rows) the
 * statement would fail on. Zero means it can run. Nothing runs it on its own:
 * a caller runs every step's pre-check before the first statement, and stops
 * when one is not zero. It reads the table without locking it beyond `SELECT`.
 */
export interface PgPrecheck {
  sql: string;
  /** What a count above zero means, e.g. `rows where email is NULL, which SET NOT NULL fails on`. */
  detail: string;
}

/** What {@link alterSteps} could not make in place: changes with no statement, each with why. */
export interface UnsupportedChange {
  change: PgChange;
  why: string;
}

// ── Names and literals ─────────────────────────────────────────────────

/** A string literal: `'` doubled (standard_conforming_strings is on). */
export const pgString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** `schema.name`, each part quoted where Postgres needs it. */
export const pgQualified = (schema: string | undefined, name: string): string => (schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name));

/**
 * An object's name in a statement. A schema and an extension have no schema;
 * a routine is named with its parameter types (`app.f(integer,text)`), a
 * trigger with its table (`touch ON app.users`).
 */
export const objectIdent = (o: { kind: CanonicalKind; schema?: string; name: string; signature?: string }): string =>
  o.kind === "schema" || o.kind === "extension" || o.kind === "role"
    ? quoteIdent(o.name)
    : o.kind === "trigger" || o.kind === "policy"
      ? `${quoteIdent(o.name)}${o.signature ?? ""}`
      : `${pgQualified(o.schema, o.name)}${o.signature ?? ""}`;

/** The words a statement names the object's kind with. */
export const KIND_WORDS: Readonly<Record<CanonicalKind, string>> = {
  schema: "SCHEMA",
  table: "TABLE",
  index: "INDEX",
  view: "VIEW",
  materializedView: "MATERIALIZED VIEW",
  sequence: "SEQUENCE",
  enum: "TYPE",
  domain: "DOMAIN",
  extension: "EXTENSION",
  function: "FUNCTION",
  procedure: "PROCEDURE",
  trigger: "TRIGGER",
  policy: "POLICY",
  role: "ROLE",
  grant: "GRANT",
  defaultPrivileges: "DEFAULT PRIVILEGES",
};

/** The canonical kind of an entity type. */
export const kindOfType = (type: string): CanonicalKind =>
  (Object.entries(POSTGRES_ENTITY_TYPES).find(([, t]) => t === type)?.[0] ?? "table") as CanonicalKind;

const step = (sql: string, cls: PgChangeClass, rule?: PgClassifierRuleId, transactional = true): PgStep => ({ sql, class: cls, transactional, ...(rule ? { rule } : {}) });
const classOf = (rule: PgClassifierRuleId): PgChangeClass => PG_CLASSIFIER_RULES[rule].class;

// ── Pre-checks (#3686) ─────────────────────────────────────────────────

/** The rows of `table` with `column` NULL: what SET NOT NULL fails on. */
export function nullPrecheck(table: string, column: string): PgPrecheck {
  return { sql: `SELECT count(*) AS n FROM ${table} WHERE ${quoteIdent(column)} IS NULL`, detail: `rows where ${column} is NULL, which SET NOT NULL fails on` };
}

/**
 * The groups of rows of `table` with the same `columns`: what a unique index
 * or a unique or primary key constraint fails on. NULLs are distinct unless
 * `nullsNotDistinct`; a primary key also counts the rows with a NULL key
 * column, which its implied NOT NULL fails on. `where` is a partial index's
 * predicate.
 */
export function duplicatePrecheck(table: string, columns: readonly string[], opts: { primaryKey?: boolean; nullsNotDistinct?: boolean; where?: string } = {}): PgPrecheck {
  const cols = columns.map(quoteIdent);
  const filter = [...(opts.primaryKey || opts.nullsNotDistinct ? [] : cols.map((c) => `${c} IS NOT NULL`)), ...(opts.where ? [`(${opts.where})`] : [])];
  const groups = `SELECT count(*) FROM (SELECT 1 FROM ${table}${filter.length ? ` WHERE ${filter.join(" AND ")}` : ""} GROUP BY ${cols.join(", ")} HAVING count(*) > 1) AS duplicates`;
  const what = columns.join(", ");
  if (!opts.primaryKey) return { sql: `SELECT (${groups}) AS n`, detail: `values of (${what}) held by more than one row, which a unique index fails on` };
  return {
    sql: `SELECT (${groups}) + (SELECT count(*) FROM ${table} WHERE ${cols.map((c) => `${c} IS NULL`).join(" OR ")}) AS n`,
    detail: `values of (${what}) held by more than one row, and rows with one of them NULL, which a primary key fails on`,
  };
}

/** The rows of `table` that fail a CHECK: its expression false (a NULL result passes). */
export function checkPrecheck(table: string, expr: string, name?: string): PgPrecheck {
  return { sql: `SELECT count(*) AS n FROM ${table} WHERE NOT (${expr})`, detail: `rows that fail the check${name ? ` ${name}` : ""} (${expr})` };
}

/**
 * The rows of `table` whose foreign key references no row: every key column
 * set and no referenced row with those values (MATCH SIMPLE, the default).
 * Undefined for a foreign key that names no referenced columns or is MATCH
 * FULL, which the query does not cover.
 */
export function foreignKeyPrecheck(table: string, fk: ForeignKeyDef): PgPrecheck | undefined {
  if (fk.refColumns.length !== fk.columns.length || (fk.match !== undefined && fk.match.toUpperCase() !== "SIMPLE")) return undefined;
  const child = fk.columns.map((c) => `c.${quoteIdent(c)}`);
  const join = fk.refColumns.map((r, i) => `p.${quoteIdent(r)} = ${child[i]}`).join(" AND ");
  return {
    sql: `SELECT count(*) AS n FROM ${table} AS c WHERE ${child.map((c) => `${c} IS NOT NULL`).join(" AND ")} AND NOT EXISTS (SELECT 1 FROM ${fk.refTable} AS p WHERE ${join})`,
    detail: `rows whose (${fk.columns.join(", ")}) references no row of ${fk.refTable}, which the foreign key${fk.name ? ` ${fk.name}` : ""} fails on`,
  };
}

/** The check that proves a column NOT NULL while SET NOT NULL runs (SQLPG210), named as the migration Op names its own. */
export const notNullCheckName = (column: string): string => pgName(`${column}__chant_nn`);

// ── Statements in a template ───────────────────────────────────────────

interface Statement {
  text: string;
  tokens: Token[];
}

/** The statements of a template's DDL, split at top-level semicolons, comments kept with the statement they precede. */
export function splitStatements(ddl: string): Statement[] {
  const tokens = tokenizeText(ddl, 0);
  const out: Statement[] = [];
  let current: Token[] = [];
  const flush = () => {
    let end = current.length;
    while (end > 0 && isTrivia(current[end - 1]!)) end--;
    const body = current.slice(0, end);
    if (body.some((t) => !isTrivia(t))) out.push({ text: body.map((t) => t.text).join("").trim(), tokens: body });
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") flush();
    else current.push(t);
  }
  flush();
  return out;
}

const firstNode = (s: Statement) => {
  try {
    return parseStatements(s.tokens)[0];
  } catch {
    return undefined;
  }
};

/** Whether a `COMMENT ON` statement sets the object's own comment, not a column's or a constraint's. */
function isOwnComment(s: Statement, kind: CanonicalKind): boolean {
  const node = firstNode(s);
  return node?.statement === "comment" && (node as CommentNode).objectType.toUpperCase() === KIND_WORDS[kind];
}

/** The declared comment with chant's trailer: what the object's own `COMMENT ON` sets. */
export function commentStatement(obj: Pick<DeclaredPgObject, "canonical">, marker: OwnershipMarker | undefined, base?: string): string {
  const declared = obj.canonical.fields.comment as string | undefined;
  return `COMMENT ON ${KIND_WORDS[obj.canonical.kind]} ${objectIdent(obj.canonical)} IS ${pgString(stampedComment(declared ?? base, marker))}`;
}

/**
 * The declared statements that create the object, its own `COMMENT ON`
 * replaced by one carrying chant's marker, so no object is left unmarked.
 * `base` is the comment kept under the trailer when nothing is declared (an
 * extension's own comment, from its control file). `orReplace` turns
 * `CREATE VIEW` into `CREATE OR REPLACE VIEW`.
 */
export function createSteps(
  obj: Pick<DeclaredPgObject, "ddl" | "canonical" | "props">,
  marker: OwnershipMarker | undefined,
  opts: { base?: string; orReplace?: boolean; cls?: PgChangeClass; rule?: PgClassifierRuleId; access?: boolean } = {},
): PgStep[] {
  const cls = opts.cls ?? "create";
  const out: PgStep[] = [];
  splitStatements(obj.ddl).forEach((s, i) => {
    if (i > 0 && isOwnComment(s, obj.canonical.kind)) return;
    // A table's row-level security is access, which only a profile that manages access applies.
    if (i > 0 && opts.access === false && firstNode(s)?.statement === "rowSecurity") return;
    let sql = s.text;
    const replaceable = obj.canonical.kind === "view" || obj.canonical.kind === "function" || obj.canonical.kind === "procedure" || (obj.canonical.kind === "trigger" && obj.canonical.fields.constraint !== true);
    if (i === 0 && opts.orReplace && replaceable && !/^\s*CREATE\s+OR\s+REPLACE\b/i.test(sql)) sql = sql.replace(/\bCREATE\s+/i, "CREATE OR REPLACE ");
    const concurrently = i === 0 && obj.canonical.kind === "index" && obj.props.concurrently === true;
    out.push({ ...step(sql, cls, opts.rule, !concurrently), ...(concurrently ? { buildsIndex: objectIdent(obj.canonical) } : {}) });
  });
  out.push(step(commentStatement(obj, marker, opts.base), cls, opts.rule));
  return out;
}

/** The `DROP` for an object a prune removes. Never `CASCADE`: what something else still uses is kept. */
export function dropStatement(kind: CanonicalKind, schema: string | undefined, name: string, signature?: string): PgStep {
  const what = objectIdent({ kind, ...(schema !== undefined ? { schema } : {}), name, ...(signature !== undefined ? { signature } : {}) });
  if (kind === "index") return step(`DROP INDEX CONCURRENTLY ${what}`, "concurrently", "SQLPG242", false);
  return step(`DROP ${KIND_WORDS[kind]} ${what}`, "drop", kind === "trigger" ? "SQLPG285" : kind === "policy" ? "SQLPG292" : "SQLPG270");
}

// ── Columns ────────────────────────────────────────────────────────────

/** A column's definition for `ADD COLUMN`: its type, storage, collation, generation, default and NOT NULL; its constraints are added on their own. */
export function columnDefinition(c: ColumnDef): string {
  const parts = [quoteIdent(c.name)];
  if (c.type) parts.push(c.type);
  if (c.storage) parts.push(`STORAGE ${c.storage}`);
  if (c.compression) parts.push(`COMPRESSION ${c.compression}`);
  if (c.collate) parts.push(`COLLATE ${c.collate}`);
  if (c.generated?.kind === "identity") parts.push(`GENERATED ${c.generated.always ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${c.generated.options ? ` (${c.generated.options})` : ""}`);
  else if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated.expr ?? ""}) ${c.generated.kind.toUpperCase()}`);
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  if (c.notNull) parts.push(c.notNullName ? `CONSTRAINT ${quoteIdent(c.notNullName)} NOT NULL` : "NOT NULL");
  return parts.join(" ");
}

const SEQUENCE_OPTION = /\b(START\s+(?:WITH\s+)?-?\s*\d+|INCREMENT\s+(?:BY\s+)?-?\s*\d+|NO\s+MINVALUE|NO\s+MAXVALUE|MINVALUE\s+-?\s*\d+|MAXVALUE\s+-?\s*\d+|CACHE\s+\d+|NO\s+CYCLE|CYCLE)\b/gi;

/** An identity column's options as `SET` clauses, the ones not written set back to their defaults. */
function identitySetClauses(options: string | undefined): string[] {
  const written = [...(options ?? "").matchAll(SEQUENCE_OPTION)].map((m) => m[1]!.replace(/\s+/g, " ").toUpperCase());
  const has = (re: RegExp) => written.some((w) => re.test(w));
  const out = written.map((w) => `SET ${w}`);
  if (!has(/^INCREMENT/)) out.push("SET INCREMENT BY 1");
  if (!has(/MINVALUE/)) out.push("SET NO MINVALUE");
  if (!has(/MAXVALUE/)) out.push("SET NO MAXVALUE");
  if (!has(/^CACHE/)) out.push("SET CACHE 1");
  if (!has(/CYCLE/)) out.push("SET NO CYCLE");
  return out;
}

const COLUMN_FIELD = /^columns\.(.+?)(?:\.(type|default|notNull|generated|identity|collate|storage|comment))?$/;

// ── Constraints ────────────────────────────────────────────────────────

/** A table's declared constraints in the canonical order (primary key, unique, check, foreign key, exclusion), each with its props. */
function declaredConstraintDefs(p: TableProps): Array<{ kind: CanonicalConstraint["kind"]; def: KeyDef | CheckDef | ForeignKeyDef | ExclusionDef }> {
  return [
    ...(p.primaryKey ? [{ kind: "PRIMARY KEY" as const, def: p.primaryKey }] : []),
    ...p.uniques.map((def) => ({ kind: "UNIQUE" as const, def })),
    ...p.checks.map((def) => ({ kind: "CHECK" as const, def })),
    ...p.foreignKeys.map((def) => ({ kind: "FOREIGN KEY" as const, def })),
    ...p.exclusions.map((def) => ({ kind: "EXCLUDE" as const, def })),
  ];
}

const deferralSql = (d: { deferrable?: boolean; initiallyDeferred?: boolean }) =>
  [d.deferrable ? "DEFERRABLE" : "", d.initiallyDeferred ? "INITIALLY DEFERRED" : ""].filter(Boolean).join(" ");

const parens = (s: string) => (s.trim().startsWith("(") ? s.trim() : `(${s.trim()})`);
const named = (name: string | undefined) => (name ? `CONSTRAINT ${quoteIdent(name)} ` : "");

/** A constraint as a table constraint (`ADD CONSTRAINT ...`), whether it was declared on a column or the table. */
export function constraintSql(kind: CanonicalConstraint["kind"], def: KeyDef | CheckDef | ForeignKeyDef | ExclusionDef): string {
  const cols = (c: string[]) => c.map(quoteIdent).join(", ");
  switch (kind) {
    case "CHECK": {
      const c = def as CheckDef;
      return [`${named(c.name)}CHECK (${c.expr})`, c.noInherit ? "NO INHERIT" : "", c.notEnforced ? "NOT ENFORCED" : "", c.notValid ? "NOT VALID" : ""].filter(Boolean).join(" ");
    }
    case "FOREIGN KEY": {
      const f = def as ForeignKeyDef;
      return [
        `${named(f.name)}FOREIGN KEY (${cols(f.columns)}) REFERENCES ${f.refTable}${f.refColumns.length ? ` (${cols(f.refColumns)})` : ""}`,
        f.match ? `MATCH ${f.match.toUpperCase()}` : "",
        f.onUpdate ? `ON UPDATE ${f.onUpdate}` : "",
        f.onDelete ? `ON DELETE ${f.onDelete}` : "",
        deferralSql(f),
        f.notEnforced ? "NOT ENFORCED" : "",
        f.notValid ? "NOT VALID" : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "EXCLUDE": {
      const x = def as ExclusionDef;
      return [
        `${named(x.name)}EXCLUDE${x.using ? ` USING ${x.using}` : ""} (${x.elements})`,
        x.include ? `INCLUDE ${parens(x.include)}` : "",
        x.with ? `WITH ${parens(x.with)}` : "",
        x.where ? `WHERE (${x.where})` : "",
        deferralSql(x),
      ]
        .filter(Boolean)
        .join(" ");
    }
    default: {
      const k = def as KeyDef;
      return [
        `${named(k.name)}${kind}${k.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} (${cols(k.columns)})`,
        k.include ? `INCLUDE ${parens(k.include)}` : "",
        k.with ? `WITH ${parens(k.with)}` : "",
        deferralSql(k),
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}

/** The name Postgres would give a key constraint's index: `<table>_pkey`, `<table>_<columns>_key`. */
function keyIndexName(table: string, kind: "PRIMARY KEY" | "UNIQUE", columns: readonly string[]): string {
  return (kind === "PRIMARY KEY" ? `${table}_pkey` : `${table}_${columns.join("_")}_key`).slice(0, 63);
}

/**
 * A primary key or unique constraint added to a table that exists: its index
 * built CONCURRENTLY outside a transaction, then the constraint made from it
 * (`ADD CONSTRAINT ... USING INDEX`), which changes only the catalog
 * (SQLPG221).
 */
function keyConstraintSteps(table: { schema?: string; name: string }, kind: "PRIMARY KEY" | "UNIQUE", k: KeyDef): PgStep[] {
  const name = k.name ?? keyIndexName(table.name, kind, k.columns);
  const index = pgQualified(table.schema, name);
  const build = [
    `CREATE UNIQUE INDEX CONCURRENTLY ${quoteIdent(name)} ON ${pgQualified(table.schema, table.name)} (${k.columns.map(quoteIdent).join(", ")})`,
    k.include ? `INCLUDE ${parens(k.include)}` : "",
    k.nullsNotDistinct ? "NULLS NOT DISTINCT" : "",
    k.with ? `WITH ${parens(k.with)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    {
      ...step(build, "concurrently", "SQLPG221", false),
      buildsIndex: index,
      precheck: duplicatePrecheck(pgQualified(table.schema, table.name), k.columns, { primaryKey: kind === "PRIMARY KEY", ...(k.nullsNotDistinct ? { nullsNotDistinct: true } : {}) }),
    },
    step(
      [`ALTER TABLE ${pgQualified(table.schema, table.name)} ADD CONSTRAINT ${quoteIdent(name)} ${kind} USING INDEX ${quoteIdent(name)}`, deferralSql(k)].filter(Boolean).join(" "),
      "metadata",
      "SQLPG221",
    ),
  ];
}

/**
 * A CHECK (SQLPG218) or a foreign key (SQLPG219) added to a table that
 * exists, without reading its rows under a lock that blocks writes: the
 * constraint added NOT VALID, which checks new rows only (SQLPG217), then
 * validated (SQLPG220), which reads the rows under SHARE UPDATE EXCLUSIVE
 * while writes go on. The applier commits between the two, since their
 * classes differ, so the validation runs in a transaction of its own. A run
 * interrupted after the first statement leaves the constraint NOT VALID on
 * the server, and the next plan validates it as found. The first statement
 * carries the pre-check (the rows the check or the foreign key refuses).
 * VALIDATE needs a name, so a constraint declared without one is given
 * {@link unnamedConstraintName}'s; the diff matches an unnamed declaration
 * to the constraint by its body, whatever it is called.
 */
/** The name given to a CHECK or foreign key declared without one: `<table>_<hash of its body>_check` or `_fkey`. */
export function unnamedConstraintName(table: string, c: Pick<CanonicalConstraint, "kind" | "body">): string {
  const hash = createHash("sha256").update(c.body).digest("hex").slice(0, 8);
  return pgName(`${table}_${hash}_${c.kind === "CHECK" ? "check" : "fkey"}`);
}

function notValidThenValidateSteps(alter: string, kind: "CHECK" | "FOREIGN KEY", def: CheckDef | ForeignKeyDef, precheck: PgPrecheck | undefined): PgStep[] {
  const add = step(`${alter} ADD ${constraintSql(kind, { ...def, notValid: true })}`, "metadata", "SQLPG217");
  return [precheck ? { ...add, precheck } : add, step(`${alter} VALIDATE CONSTRAINT ${quoteIdent(def.name!)}`, "validate", "SQLPG220")];
}

/**
 * The constraint changes of a table or a domain, matched the way the diff
 * matches them (`../plan/diff.ts`): a declared constraint the server lacks is
 * added, one the server holds NOT VALID and the declaration does not is
 * validated, one the declaration lost is dropped, and a changed comment is
 * set.
 */
function constraintSteps(obj: DeclaredPgObject, live: PgDiffObject, keep: ReadonlySet<string> = new Set()): PgStep[] {
  const domain = obj.canonical.kind === "domain";
  const target = objectIdent(obj.canonical);
  const alter = domain ? `ALTER DOMAIN ${target}` : `ALTER TABLE ${target}`;
  const defs = domain
    ? (obj.props as unknown as DomainProps).checks.map((def) => ({ kind: "CHECK" as const, def: def as CheckDef }))
    : declaredConstraintDefs(obj.props as unknown as TableProps);
  // A NOT NULL proof left by an interrupted SET NOT NULL (SQLPG210) is that sequence's to reuse and drop.
  const remaining = live.constraints.filter((b) => !(b.name && keep.has(b.name)));
  const out: PgStep[] = [];
  /** What the rows must pass for a CHECK or a foreign key to be valid. */
  const precheckOf = (kind: CanonicalConstraint["kind"], def: unknown): PgPrecheck | undefined =>
    domain || def === undefined ? undefined : kind === "CHECK" ? checkPrecheck(target, (def as CheckDef).expr, (def as CheckDef).name) : kind === "FOREIGN KEY" ? foreignKeyPrecheck(target, def as ForeignKeyDef) : undefined;
  const withPrecheck = (s: PgStep, p: PgPrecheck | undefined): PgStep => (p ? { ...s, precheck: p } : s);
  obj.canonical.constraints.forEach((a, i) => {
    const def = defs[i]?.def;
    const at = remaining.findIndex((b) => sameConstraint(a, b));
    if (at < 0) {
      if (!def) return;
      if (domain) {
        const c = def as CheckDef;
        out.push(step(`${alter} ADD ${named(c.name)}CHECK (${c.expr})${c.notValid ? " NOT VALID" : ""}`, c.notValid ? "metadata" : "validate", c.notValid ? "SQLPG217" : "SQLPG262"));
      } else if ((a.kind === "PRIMARY KEY" || a.kind === "UNIQUE") && !a.notValid) {
        out.push(...keyConstraintSteps(obj.canonical, a.kind, def as KeyDef));
      } else if ((a.kind === "CHECK" || a.kind === "FOREIGN KEY") && !a.notValid && !(def as { notEnforced?: boolean }).notEnforced) {
        const d = def as CheckDef | ForeignKeyDef;
        const withName = d.name ? d : { ...d, name: unnamedConstraintName(obj.canonical.name, a) };
        out.push(...notValidThenValidateSteps(alter, a.kind, withName, precheckOf(a.kind, withName)));
      } else {
        const rule = addConstraintRule(a);
        out.push(withPrecheck(step(`${alter} ADD ${constraintSql(a.kind, def)}`, classOf(rule), rule), rule === "SQLPG217" || (def as { notEnforced?: boolean }).notEnforced ? undefined : precheckOf(a.kind, def)));
      }
      if (a.comment !== undefined) {
        const name = a.name ?? (def as { name?: string }).name;
        if (name) out.push(step(`COMMENT ON CONSTRAINT ${quoteIdent(name)} ON ${domain ? "DOMAIN " : ""}${target} IS ${pgString(a.comment)}`, "metadata", "SQLPG216"));
      }
      return;
    }
    const b = remaining.splice(at, 1)[0]!;
    const name = b.name ?? a.name;
    if (!name) return;
    if (b.notValid && !a.notValid) out.push(withPrecheck(step(`${alter} VALIDATE CONSTRAINT ${quoteIdent(name)}`, "validate", "SQLPG220"), precheckOf(a.kind, def)));
    if (b.comment !== a.comment) {
      out.push(step(`COMMENT ON CONSTRAINT ${quoteIdent(name)} ON ${domain ? "DOMAIN " : ""}${target} IS ${a.comment === undefined ? "NULL" : pgString(a.comment)}`, "metadata", "SQLPG216"));
    }
  });
  for (const b of remaining) if (b.name) out.push(step(`${alter} DROP CONSTRAINT ${quoteIdent(b.name)}`, "metadata", domain ? "SQLPG263" : "SQLPG223"));
  return out;
}

// ── Options ────────────────────────────────────────────────────────────

/** `SET (...)` for options the declaration sets differently and `RESET (...)` for those it drops. */
function optionSteps(alter: string, declared: unknown, live: unknown, rule: PgClassifierRuleId): PgStep[] {
  const d = (declared ?? {}) as Record<string, string>;
  const l = (live ?? {}) as Record<string, string>;
  const set = Object.entries(d).filter(([k, v]) => l[k] !== v);
  const reset = Object.keys(l).filter((k) => !(k in d));
  return [
    ...(set.length ? [step(`${alter} SET (${set.map(([k, v]) => `${k} = ${/^[A-Za-z0-9_.-]+$/.test(v) ? v : pgString(v)}`).join(", ")})`, classOf(rule), rule)] : []),
    ...(reset.length ? [step(`${alter} RESET (${reset.join(", ")})`, classOf(rule), rule)] : []),
  ];
}

/** `ALTER SEQUENCE`'s options for what is declared, every option left out set back to its default. */
export function sequenceOptionsSql(p: SequenceProps): string {
  const inc = (p.increment ?? "1").replace(/\s+/g, "");
  const ascending = !inc.startsWith("-");
  const start = p.start ?? (ascending ? (p.minValue ?? "1") : (p.maxValue ?? "-1"));
  return [
    `AS ${p.dataType ?? "bigint"}`,
    `INCREMENT BY ${inc}`,
    p.minValue === undefined || p.minValue === null ? "NO MINVALUE" : `MINVALUE ${p.minValue}`,
    p.maxValue === undefined || p.maxValue === null ? "NO MAXVALUE" : `MAXVALUE ${p.maxValue}`,
    `START WITH ${String(start).replace(/\s+/g, "")}`,
    `CACHE ${p.cache ?? "1"}`,
    p.cycle ? "CYCLE" : "NO CYCLE",
    `OWNED BY ${p.ownedBy ?? "NONE"}`,
  ].join(" ");
}

// ── Changes ────────────────────────────────────────────────────────────

/** Changes a plan refuses to make in place: expand and contract, by the migration Op (#3281). */
export const isRefused = (c: PgChange): boolean => c.class === "expand";

/** Changes that destroy data, which only an apply allowed to delete makes. */
export const isDestructive = (c: PgChange): boolean => c.rule === "SQLPG204";

/** Changes that replace the object: drop it and create it again from its declaration. */
export const isRecreate = (c: PgChange): boolean => c.rule === "SQLPG252" || c.rule === "SQLPG243" || c.rule === "SQLPG281";

/**
 * SET NOT NULL on a table that exists, without reading the table under
 * ACCESS EXCLUSIVE (SQLPG210): a CHECK (column IS NOT NULL) added NOT VALID,
 * which reads no rows; validated, which reads them under SHARE UPDATE
 * EXCLUSIVE while writes go on; then SET NOT NULL, which the valid check
 * proves without a scan (12 and later), and the check dropped. The applier
 * commits between the catalog changes and the validation, so the brief
 * ACCESS EXCLUSIVE locks are never held across the scan. A check left by an
 * interrupted run is validated as found. The first statement carries the
 * NULL count as its pre-check. 18's `NOT NULL ... NOT VALID` would save the
 * last statement; the check is used on every major for one sequence.
 */
export function setNotNullSteps(table: string, column: string, live?: Pick<PgDiffObject, "constraints">): PgStep[] {
  const check = quoteIdent(notNullCheckName(column));
  const left = live?.constraints.some((k) => k.name === notNullCheckName(column)) ?? false;
  const steps = [
    ...(left ? [] : [step(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (${quoteIdent(column)} IS NOT NULL) NOT VALID`, "metadata", "SQLPG217")]),
    step(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${check}`, "validate", "SQLPG220"),
    step(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(column)} SET NOT NULL`, "metadata", "SQLPG210"),
    step(`ALTER TABLE ${table} DROP CONSTRAINT ${check}`, "metadata", "SQLPG223"),
  ];
  steps[0] = { ...steps[0]!, precheck: nullPrecheck(table, column) };
  return steps;
}

/**
 * The statements for an object that exists on the server, change by change.
 * `live` is the server's definition, matched to the declaration (a renamed
 * index by its `-- previously:` name). What has no statement in place is
 * returned in `unsupported`, so the applier can refuse the object rather
 * than make half of it.
 */
export function alterSteps(
  obj: DeclaredPgObject,
  live: PgDiffObject,
  changes: readonly PgChange[],
  opts: { marker?: OwnershipMarker; major: number },
): { steps: PgStep[]; unsupported: UnsupportedChange[] } {
  const steps: PgStep[] = [];
  const unsupported: UnsupportedChange[] = [];
  const d = obj.canonical;
  const target = objectIdent(d);
  const alterKind = `ALTER ${KIND_WORDS[d.kind]} ${target}`;
  const columns = new Map(((obj.props.columns as ColumnDef[] | undefined) ?? []).map((c) => [c.name, c]));
  const liveColumns = new Map(live.columns.map((c) => [c.name, c]));
  const declaredColumns = new Map(d.columns.map((c) => [c.name, c]));
  let constraintsDone = false;
  let recreated = false;
  const notNullChecks = new Set(changes.filter((c) => c.rule === "SQLPG210" && c.class !== "metadata").map((c) => notNullCheckName(COLUMN_FIELD.exec(c.field)?.[1] ?? "")));

  for (const c of changes) {
    const no = (why: string) => unsupported.push({ change: c, why });
    if (isRecreate(c)) {
      if (recreated) continue;
      recreated = true;
      const concurrently = d.kind === "index" && obj.props.concurrently === true;
      steps.push(step(d.kind === "index" ? `DROP INDEX${concurrently ? " CONCURRENTLY" : ""} ${objectIdent(live)}` : `DROP ${KIND_WORDS[d.kind]} ${objectIdent(live)}`, c.class, c.rule, !concurrently));
      steps.push(...createSteps(obj, opts.marker, { cls: c.class, rule: c.rule }));
      continue;
    }
    if (c.field.startsWith("constraints.")) {
      if (!constraintsDone) steps.push(...constraintSteps(obj, live, notNullChecks));
      constraintsDone = true;
      continue;
    }
    const col = COLUMN_FIELD.exec(c.field);
    if (col && (d.kind === "table")) {
      const name = col[1]!;
      const prop = col[2];
      const def = columns.get(name);
      const dc = declaredColumns.get(name);
      const lc = liveColumns.get(name);
      const column = `${alterKind} ALTER COLUMN ${quoteIdent(name)}`;
      switch (c.rule) {
        case "SQLPG201":
        case "SQLPG202":
          if (!def) no(`column ${name} is not in the declaration`);
          else steps.push(step(`${alterKind} ADD COLUMN ${columnDefinition(def)}`, c.class, c.rule));
          break;
        case "SQLPG204":
          steps.push(step(`${alterKind} DROP COLUMN ${quoteIdent(name)}`, c.class, c.rule));
          break;
        case "SQLPG206":
        case "SQLPG207":
        case "SQLPG214":
          if (!def?.type) no(`column ${name} declares no type`);
          else steps.push(step(`${column} TYPE ${def.type}${def.collate ? ` COLLATE ${def.collate}` : prop === "collate" ? ' COLLATE "default"' : ""}`, c.class, c.rule));
          break;
        case "SQLPG209":
          steps.push(step(def?.default !== undefined ? `${column} SET DEFAULT ${def.default}` : `${column} DROP DEFAULT`, c.class, c.rule));
          break;
        case "SQLPG210":
          // A valid check the server already holds proves it (the diff classes that metadata): SET NOT NULL alone.
          if (c.class === "metadata") steps.push(step(`${column} SET NOT NULL`, c.class, c.rule));
          else steps.push(...setNotNullSteps(target, name, live));
          break;
        case "SQLPG211":
          steps.push(step(`${column} DROP NOT NULL`, c.class, c.rule));
          break;
        case "SQLPG212": {
          const before = lc?.generated?.split(" ")[0];
          const after = def?.generated?.kind;
          if (after && after !== "identity" && before === after) steps.push(step(`${column} SET EXPRESSION AS (${def!.generated!.expr ?? ""})`, c.class, c.rule));
          else if (!after && before === "stored") steps.push(step(`${column} DROP EXPRESSION`, c.class, c.rule));
          else no(`a generated column's kind cannot change in place (${before ?? "not generated"} to ${after ?? "not generated"}); the column is dropped and added`);
          break;
        }
        case "SQLPG213": {
          const g = def?.generated?.kind === "identity" ? def.generated : undefined;
          if (!g) steps.push(step(`${column} DROP IDENTITY`, c.class, c.rule));
          else if (!lc?.identity) steps.push(step(`${column} ADD GENERATED ${g.always ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${g.options ? ` (${g.options})` : ""}`, c.class, c.rule));
          else steps.push(step(`${column} SET GENERATED ${g.always ? "ALWAYS" : "BY DEFAULT"} ${identitySetClauses(g.options).join(" ")}`, c.class, c.rule));
          break;
        }
        case "SQLPG215": {
          if (dc?.storage !== lc?.storage) {
            if (def?.storage) steps.push(step(`${column} SET STORAGE ${def.storage}`, c.class, c.rule));
            else if (opts.major >= 16) steps.push(step(`${column} SET STORAGE DEFAULT`, c.class, c.rule));
            else no(`Postgres ${opts.major} has no SET STORAGE DEFAULT; write the type's storage to set it back`);
          }
          if (dc?.compression !== lc?.compression) steps.push(step(`${column} SET COMPRESSION ${def?.compression ?? "DEFAULT"}`, c.class, c.rule));
          break;
        }
        case "SQLPG216":
          steps.push(step(`COMMENT ON COLUMN ${target}.${quoteIdent(name)} IS ${dc?.comment === undefined ? "NULL" : pgString(dc.comment)}`, c.class, c.rule));
          break;
        default:
          no("no in-place statement");
      }
      continue;
    }
    switch (c.rule) {
      case "SQLPG216":
        if (c.field === "comment") steps.push(step(commentStatement(obj, opts.marker), c.class, c.rule));
        else if (c.field === "columnComments") {
          const dcc = (d.fields.columnComments ?? {}) as Record<string, string>;
          const lcc = (live.fields.columnComments ?? {}) as Record<string, string>;
          for (const k of [...new Set([...Object.keys(lcc), ...Object.keys(dcc)])]) {
            if (dcc[k] !== lcc[k]) steps.push(step(`COMMENT ON COLUMN ${target}.${quoteIdent(k)} IS ${dcc[k] === undefined ? "NULL" : pgString(dcc[k]!)}`, c.class, c.rule));
          }
        }
        // VALID to NOT VALID on a constraint is a note, not a change: nothing to send.
        break;
      case "SQLPG224":
      case "SQLPG253":
        if (c.field === "checkOption") {
          const opt = d.fields.checkOption as string | undefined;
          steps.push(step(opt ? `${alterKind} SET (check_option = ${opt})` : `${alterKind} RESET (check_option)`, c.class, c.rule));
        } else steps.push(...optionSteps(alterKind, d.fields.with, live.fields.with, c.rule));
        break;
      case "SQLPG225":
        steps.push(step(`${alterKind} SET ${d.fields.unlogged ? "UNLOGGED" : "LOGGED"}`, c.class, c.rule));
        break;
      case "SQLPG226":
        if (c.field === "using") steps.push(step(`${alterKind} SET ACCESS METHOD ${quoteIdent(String(d.fields.using ?? "heap"))}`, c.class, c.rule));
        else steps.push(step(`${alterKind} SET TABLESPACE ${quoteIdent(String(d.fields.tablespace ?? "pg_default"))}`, c.class, c.rule));
        break;
      case "SQLPG229":
        steps.push(step(`ALTER INDEX ${objectIdent(live)} RENAME TO ${quoteIdent(d.name)}`, c.class, c.rule));
        break;
      case "SQLPG250":
      case "SQLPG280":
        steps.push(...createSteps(obj, opts.marker, { orReplace: true, cls: c.class, rule: c.rule }).slice(0, 1));
        break;
      case "SQLPG291": {
        const p = obj.props as unknown as PolicyProps;
        const recreate =
          ["table", "restrictive", "command"].some((k) => !same(d.fields[k], live.fields[k])) ||
          (live.fields.using !== undefined && d.fields.using === undefined) ||
          (live.fields.check !== undefined && d.fields.check === undefined);
        if (recreate) {
          steps.push(step(`DROP POLICY ${objectIdent(live)}`, c.class, c.rule));
          steps.push(...createSteps(obj, opts.marker, { cls: c.class, rule: c.rule }));
        } else {
          const roles = p.roles.map((r) => (r === "public" ? "PUBLIC" : quoteIdent(r))).join(", ");
          steps.push(step([`ALTER POLICY ${objectIdent(d)} TO ${roles}`, p.using ? `USING (${p.using})` : "", p.check ? `WITH CHECK (${p.check})` : ""].filter(Boolean).join(" "), c.class, c.rule));
        }
        break;
      }
      case "SQLPG293":
        if (!same(d.fields.rowSecurity, live.fields.rowSecurity)) steps.push(step(`${alterKind} ${d.fields.rowSecurity ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`, c.class, c.rule));
        if (!same(d.fields.forceRowSecurity, live.fields.forceRowSecurity)) steps.push(step(`${alterKind} ${d.fields.forceRowSecurity ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY`, c.class, c.rule));
        break;
      case "SQLPG294": {
        if (steps.some((x) => x.rule === "SQLPG294")) break;
        const want = new Set((d.fields.attributes as string[] | undefined) ?? []);
        const have = new Set((live.fields.attributes as string[] | undefined) ?? []);
        const flip = (a: string) => (a.startsWith("no") ? a.slice(2) : `no${a}`);
        // An attribute at its default is in neither set: write the side that changes.
        const words = [...[...want].filter((a) => !have.has(a)), ...[...have].filter((a) => !want.has(a)).map(flip)];
        const limit = d.fields.connectionLimit !== live.fields.connectionLimit ? [`CONNECTION LIMIT ${String(d.fields.connectionLimit ?? -1)}`] : [];
        steps.push(step(`ALTER ROLE ${objectIdent(d)} WITH ${[...words.map((w) => w.toUpperCase()), ...limit].join(" ")}`, c.class, c.rule));
        break;
      }
      case "SQLPG284":
        if (d.fields.constraint === true || live.fields.constraint === true || d.signature !== live.signature) {
          steps.push(step(`DROP TRIGGER ${objectIdent(live)}`, c.class, c.rule));
          steps.push(...createSteps(obj, opts.marker, { cls: c.class, rule: c.rule }));
        } else steps.push(...createSteps(obj, opts.marker, { orReplace: true, cls: c.class, rule: c.rule }).slice(0, 1));
        break;
      case "SQLPG260": {
        const before = (live.fields.labels as string[] | undefined) ?? [];
        const after = (d.fields.labels as string[] | undefined) ?? [];
        const present = new Set(before);
        after.forEach((label, i) => {
          if (present.has(label)) return;
          const prev = after.slice(0, i).reverse().find((l) => present.has(l));
          const next = after.slice(i + 1).find((l) => present.has(l));
          const where = prev !== undefined ? ` AFTER ${pgString(prev)}` : next !== undefined ? ` BEFORE ${pgString(next)}` : "";
          // Kept out of a transaction: a label added in one cannot be used in it.
          steps.push(step(`ALTER TYPE ${target} ADD VALUE ${pgString(label)}${where}`, c.class, c.rule, false));
          present.add(label);
        });
        break;
      }
      case "SQLPG262":
      case "SQLPG263":
        if (c.field === "notNull") steps.push(step(`${alterKind} ${d.fields.notNull ? "SET" : "DROP"} NOT NULL`, c.class, c.rule));
        else if (c.field === "default") steps.push(step(d.fields.default !== undefined ? `${alterKind} SET DEFAULT ${(obj.props as unknown as DomainProps).default}` : `${alterKind} DROP DEFAULT`, c.class, c.rule));
        else no("no in-place statement");
        break;
      case "SQLPG265":
        if (!steps.some((s) => s.rule === "SQLPG265")) steps.push(step(`${alterKind} ${sequenceOptionsSql(obj.props as unknown as SequenceProps)}`, c.class, c.rule));
        break;
      case "SQLPG266":
        if (c.field === "version") steps.push(step(`${alterKind} UPDATE${d.fields.version ? ` TO ${pgString(String(d.fields.version))}` : ""}`, c.class, c.rule));
        else if (d.fields.schema !== undefined) steps.push(step(`${alterKind} SET SCHEMA ${quoteIdent(String(d.fields.schema))}`, c.class, c.rule));
        break;
      case "SQLPG267":
        if (obj.props.authorization !== undefined) steps.push(step(`${alterKind} OWNER TO ${String(obj.props.authorization)}`, c.class, c.rule));
        break;
      default:
        no("no in-place statement");
    }
  }
  return { steps, unsupported };
}

/** Whether a change class reads or rewrites rows, so its statement runs in a transaction of its own with the scan timeout. */
export const scansRows = (cls: PgChangeClass): boolean => cls === "rewrite" || cls === "validate" || cls === "concurrently";

/**
 * The detail of a refused object: each change, the rule and restriction
 * behind it, and the Op that makes it. `declared` is the object as declared,
 * which names the table a column rename or type change is handed to
 * `PostgresMigrationOp` for (`../migrate/handoff.ts`).
 */
export function refusalDetail(changes: readonly PgChange[], name: string, declared?: Pick<PgDiffObject, "kind" | "schema" | "name">): string {
  const lines = changes.map((c) => {
    const r = PG_CLASSIFIER_RULES[c.rule];
    const what = [c.field, c.before !== undefined || c.after !== undefined ? `${c.before ?? "-"} -> ${c.after ?? "-"}` : ""].filter(Boolean).join(" ");
    return `${r.id} ${r.title} (${what}): ${c.note ? `${c.note}. ` : ""}${r.restriction} ${r.cite}`;
  });
  const ops = [...new Set(changes.map((c) => migrationTarget(c, declared)).filter((t) => t !== undefined).map((t) => `PostgresMigrationOp({ table: ${JSON.stringify(t.table)}, column: ${JSON.stringify(t.column)}, ... })`))];
  const instead =
    ops.length > 0
      ? `Run it as the expand-and-contract migration Op: ${ops.join(", ")} from @intentius/chant-lexicon-sql/postgres (add the new column, write both, backfill, switch readers, then drop the old).` +
        (ops.length < changes.length ? " The other changes have no migration Op yet: make them by hand as expand and contract." : "")
      : "No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).";
  return `${name} needs expand and contract, which no in-place statement makes, so nothing was sent for it. ${lines.join(" ")} ${instead}`;
}

// ── A schema's statements ──────────────────────────────────────────────

/**
 * What one declared object takes, as the applier and the offline renderer
 * (`../../migration-statements.ts`) both see it:
 *
 * - `create` or `alter`: the statements, in the order they run. An `alter`
 *   with none is an object already as declared.
 * - `foreign`: another tool keeps the object; it is not chant's to change.
 * - `refused`: a change only expand and contract makes; nothing is sent for
 *   the object, and `detail` names the migration Op where one makes it.
 * - `unsupported`: a change with no in-place statement; nothing is sent.
 * - `withheld`: a column drop, which destroys data, in a plan not allowed to
 *   delete.
 */
export type PgObjectStatements =
  | { verdict: "create" | "alter"; obj: DeclaredPgObject; changes: PgChange[]; steps: PgStep[]; live?: PgDiffObject }
  | { verdict: "foreign"; obj: DeclaredPgObject; changes: PgChange[]; live: PgDiffObject; detail: string }
  | { verdict: "refused"; obj: DeclaredPgObject; changes: PgChange[]; refused: PgChange[]; live?: PgDiffObject; detail: string }
  | { verdict: "unsupported"; obj: DeclaredPgObject; changes: PgChange[]; unsupported: UnsupportedChange[]; live: PgDiffObject; detail: string }
  | { verdict: "withheld"; obj: DeclaredPgObject; changes: PgChange[]; withheld: PgChange[]; live?: PgDiffObject; detail: string };

/** An object the declarations no longer hold, and the `DROP` for it. */
export interface PgDropStatement {
  /** The key the changes name it by. */
  key: string;
  kind: CanonicalKind;
  schema?: string;
  name: string;
  /** A routine's parameter types, a trigger's table. */
  signature?: string;
  step: PgStep;
}

export interface PgStatementPlanInput {
  /** The declared objects in creation order, in the canonical form the changes were found for. */
  declared: readonly DeclaredPgObject[];
  /** The classified changes from the current schema to the declared one. */
  changes: readonly PgChange[];
  /** The current schema, keyed as the changes key objects. */
  current: readonly PgSchemaObject[];
  /** How the changes key a declared object: its qualified key against a server (the default), its export name between two builds. */
  keyOf?: (obj: DeclaredPgObject) => string;
  /** The major the statements are for. */
  major: number;
  /** The marker every created object and restamped comment carries. */
  marker?: OwnershipMarker;
  /** Column drops are planned, not withheld. Default: off. */
  allowDestructive?: boolean;
  /** Whether the current object carries the marker already; one that does not is restamped. Default: it does. */
  carriesMarker?: (live: PgDiffObject, currentKey: string) => boolean;
  /** The comment an extension's control file sets, kept under the trailer when the declaration sets none. */
  extensionComment?: (name: string) => string | undefined;
  /** Whether access is managed: off, a table is created without its row-level security statements. Default: on. */
  access?: boolean;
}

export interface PgStatementPlan {
  /** One entry per declared object, in creation order. */
  objects: PgObjectStatements[];
  /** The objects the declarations no longer hold, in drop order: views first, a schema last. */
  drops: PgDropStatement[];
}

/** Drop order: what reads from a table before the table, types after the tables using them, a schema last. */
const DROP_ORDER: Record<CanonicalKind, number> = {
  grant: 0,
  defaultPrivileges: 0,
  policy: 0,
  trigger: 0,
  materializedView: 1,
  view: 2,
  index: 3,
  table: 4,
  sequence: 5,
  // A routine after what calls it (a view, a trigger, a default), before the types its parameters use.
  function: 6,
  procedure: 6,
  domain: 7,
  enum: 8,
  extension: 9,
  schema: 10,
  // A role is the cluster's: never dropped by a prune (`../live/catalog.ts` reads only the declared ones).
  role: 11,
};

/** A unique index's duplicate count, when every element is a plain column; undefined otherwise. */
function uniqueIndexPrecheck(p: IndexProps): PgPrecheck | undefined {
  if (!p.unique || p.elements.length === 0 || p.elements.some((e) => e.column === undefined)) return undefined;
  return duplicatePrecheck(p.tableName, p.elements.map((e) => e.column!), { ...(p.nullsNotDistinct ? { nullsNotDistinct: true } : {}), ...(p.where ? { where: p.where } : {}) });
}

/**
 * The statements that take the current schema to the declared one, from the
 * classified changes between them. Pure: nothing is read or sent. The applier
 * (`./apply.ts`) groups the steps into transactions and runs them;
 * `diffStatements` (`../../migration-statements.ts`) renders the same steps
 * for a migration file.
 */
export function planPgStatements(input: PgStatementPlanInput): PgStatementPlan {
  const keyOf = input.keyOf ?? ((o: DeclaredPgObject) => o.key);
  const byObject = new Map<string, PgChange[]>();
  for (const c of input.changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  const currentByKey = new Map(input.current.map((o) => [o.key, o.canonical]));
  const matched = new Map<string, string>();
  for (const m of matchPgObjects(input.current, input.declared.map((o) => ({ key: keyOf(o), canonical: o.canonical })))) {
    if (m.kind === "matched") matched.set(m.after.key, m.before.key);
  }

  const recreatedRelations = new Set<string>();
  // Grants and default privileges are access, made by their own statements (`../access/acl.ts`).
  const objects = input.declared.filter((obj) => !ACCESS_KINDS.has(obj.canonical.kind)).map((obj): PgObjectStatements => {
    const key = keyOf(obj);
    const currentKey = matched.get(key);
    const live = currentKey !== undefined ? currentByKey.get(currentKey) : undefined;
    const mine = byObject.get(key) ?? [];
    const withLive = live ? { live } : {};

    if (live?.foreign) return { verdict: "foreign", obj, changes: mine, live, detail: `${live.foreign} keeps ${obj.name}; it is not chant's to change` };
    const refused = mine.filter(isRefused);
    if (refused.length > 0) return { verdict: "refused", obj, changes: mine, refused, ...withLive, detail: refusalDetail(refused, obj.name, obj.canonical) };
    const destructive = mine.filter(isDestructive);
    if (destructive.length > 0 && !input.allowDestructive) {
      return {
        verdict: "withheld",
        obj,
        changes: mine,
        withheld: destructive,
        ...withLive,
        detail: `drops ${destructive.map((c) => c.field).join(", ")}, which destroys the data in it; an apply that may delete (prune, ApplyOp delete "owned-only" or "gated") makes it`,
      };
    }

    // An index on a materialized view this plan recreates went with the view, so it is created again.
    const onRecreated = obj.canonical.kind === "index" && recreatedRelations.has(String(obj.canonical.fields.table));
    if (!live || onRecreated) {
      const base = obj.canonical.kind === "extension" && !live ? input.extensionComment?.(obj.canonical.name) : undefined;
      // An index on a table that exists is built under the scan timeout (SQLPG240, SQLPG241); one on a new table is part of the create.
      const how = mine.find((c) => c.rule === "SQLPG200" || c.rule === "SQLPG240" || c.rule === "SQLPG241");
      const steps = createSteps(obj, input.marker, { ...(base !== undefined ? { base } : {}), ...(how ? { cls: how.class, rule: how.rule } : {}), ...(input.access === false ? { access: false } : {}) });
      // A unique index on a table that has rows fails on duplicates: its build carries their count.
      const unique = how && how.rule !== "SQLPG200" && obj.canonical.kind === "index" ? uniqueIndexPrecheck(obj.props as unknown as IndexProps) : undefined;
      if (unique && steps[0]) steps[0] = { ...steps[0], precheck: unique };
      return { verdict: "create", obj, changes: mine, steps, ...withLive };
    }

    const altered = alterSteps(obj, live, mine, { ...(input.marker ? { marker: input.marker } : {}), major: input.major });
    if (altered.unsupported.length > 0) {
      return {
        verdict: "unsupported",
        obj,
        changes: mine,
        unsupported: altered.unsupported,
        live,
        detail: `${obj.name}: ${altered.unsupported.map((u) => `${u.change.rule} ${u.change.field}: ${u.why}`).join("; ")}. Nothing was sent for it.`,
      };
    }
    const steps = altered.steps;
    if (mine.some((c) => c.rule === "SQLPG252")) recreatedRelations.add(`${obj.canonical.schema}.${obj.canonical.name}`);
    const stamp = commentStatement(obj, input.marker);
    if (!steps.some((s) => s.sql === stamp) && !(input.carriesMarker?.(live, currentKey!) ?? true)) steps.push(step(stamp, "metadata", "SQLPG216"));
    return { verdict: "alter", obj, changes: mine, steps, live };
  });

  const drops: PgDropStatement[] = [];
  for (const c of input.changes) {
    if (!((c.rule === "SQLPG270" || c.rule === "SQLPG242" || c.rule === "SQLPG285" || c.rule === "SQLPG292") && c.after === undefined)) continue;
    const o = currentByKey.get(c.object);
    if (!o || o.foreign) continue;
    const schema = o.kind === "schema" || o.kind === "extension" ? undefined : o.schema;
    drops.push({
      key: c.object,
      kind: o.kind,
      ...(schema !== undefined ? { schema } : {}),
      name: o.name,
      ...(o.signature !== undefined ? { signature: o.signature } : {}),
      step: dropStatement(o.kind, schema, o.name, o.signature),
    });
  }
  drops.sort((a, b) => DROP_ORDER[a.kind] - DROP_ORDER[b.kind]);
  return { objects, drops };
}
