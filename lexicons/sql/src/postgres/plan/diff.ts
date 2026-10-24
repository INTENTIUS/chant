/**
 * The diff between two Postgres schemas, each change classified by the lock
 * it takes and whether it reads or rewrites the table (`./rules.ts`).
 *
 * Identity, as for ClickHouse (#3237): an object is its export name between
 * two builds, so a changed SQL name under the same export is a rename;
 * against a server it is its qualified name, and `-- previously: <old name>`
 * before the CREATE declares a rename. A column is its name; a column renamed
 * in place says `-- previously: <old name>` on its line, and without the hint
 * a drop and an add of the same type in the same place get a hint.
 *
 * A constraint the declaration leaves unnamed is matched by what it says, so
 * the name Postgres gave it is not a change.
 */

import { classifiedChange, type ChangeSet, type ClassifiedChange } from "../../core/classifier";
import { matchByIdentity } from "../../core/diff";
import { PG_CLASSIFIER_RULES, type PgChangeClass, type PgClassifierRuleId } from "./rules";
import { ACCESS_KINDS, sameConstraint, serialBase, type CanonicalColumn, type CanonicalConstraint } from "./normalize";
import { builtinEntries, declaredAccess, diffAccess, entryKey, targetKey, type AccessChange } from "../access/acl";
import { pgNamespace, type PgDiffObject, type PgSchemaObject } from "./schema";
import { POSTGRES_LATEST_MAJOR } from "../../spec/postgres-pin";
import type { PostgresMigrationOpSuggestion } from "../migrate/handoff";

/** What the diff needs to know beyond the two schemas: the server's major (`sql.postgresMajor`, else the newest pinned). */
export interface PgDiffOptions {
  major?: number;
  /**
   * Whether to compare the access the two sides declare (grants, revokes,
   * default privileges). On by default, for a diff between two builds; a plan
   * against a server compares the server's access itself (`./commands.ts`).
   */
  access?: boolean;
}

export type PgChange = ClassifiedChange<PgClassifierRuleId, PgChangeClass>;

export interface PgSchemaDiff extends ChangeSet<PgChange> {
  /** The changes a plan refuses to make in place: expand and contract only. */
  refused: PgChange[];
  /** The `PostgresMigrationOp` to run for each refused column rename or type change (#3281). */
  migrationOps?: PostgresMigrationOpSuggestion[];
  /** The access changes among `changes`, each with its GRANT, REVOKE or ALTER DEFAULT PRIVILEGES statements (#3681). */
  access?: AccessChange[];
}

const change = (object: string, field: string, rule: PgClassifierRuleId, before?: unknown, after?: unknown, extra: Partial<PgChange> = {}): PgChange =>
  classifiedChange(PG_CLASSIFIER_RULES, object, field, rule, before, after, extra);

const qualified = (o: PgDiffObject) => `${o.schema ? `${o.schema}.` : ""}${o.name}${o.kind === "trigger" || o.kind === "policy" ? "" : (o.signature ?? "")}`;

// ── Columns ────────────────────────────────────────────────────────────

/**
 * Volatile functions a default may call, from `pg_proc.provolatile = 'v'` at
 * 18.6: a default that calls one has to be computed per row, so ADD COLUMN
 * with it rewrites the table. `now()` and `current_timestamp` are stable and
 * do not.
 */
const VOLATILE = /\b(clock_timestamp|timeofday|random|random_normal|setseed|gen_random_uuid|uuidv4|uuidv7|uuid_generate_v1|uuid_generate_v1mc|uuid_generate_v4|nextval|txid_current|pg_current_xact_id|statement_timestamp)\s*\(/;

/** Whether a type change needs no rewrite: binary-coercible, per ALTER TABLE's Notes. */
function coercible(before: string, after: string): boolean {
  if (before === after) return true;
  const vc = (t: string) => /^character varying(\((\d+)\))?$/.exec(t);
  const b = vc(before);
  const a = vc(after);
  if (b && (after === "text" || (a && (!a[2] || (b[2] && Number(a[2]) >= Number(b[2])))))) return true;
  if (before === "text" && after === "character varying") return true;
  const num = (t: string) => /^numeric(\((\d+),(\d+)\))?$/.exec(t);
  const nb = num(before);
  const na = num(after);
  if (nb && na && (!na[1] || (nb[1] && na[3] === nb[3] && Number(na[2]) >= Number(nb[2])))) return true;
  if (before === "cidr" && after === "inet") return true;
  return false;
}

/** The kind of value a type holds, for telling a widening from a change of kind. */
function family(t: string): string {
  const base = t.replace(/\(.*\)/, "").replace(/\[\]$/, "");
  if (/^(smallint|integer|bigint|numeric|real|double precision|serial|bigserial|smallserial)$/.test(base)) return "number";
  if (/^(text|character varying|character|"char"|name|citext)$/.test(base) || base.endsWith(".citext")) return "string";
  if (/^(timestamp|time|date|interval)/.test(base)) return "time";
  return base;
}

function diffColumns(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], hints: string[], tableIsNew: boolean, major: number): void {
  const byName = new Map(before.columns.map((c) => [c.name, c]));
  const afterNames = new Set(after.columns.map((c) => c.name));
  const matched = new Set<string>();
  const added: CanonicalColumn[] = [];
  const checksProvingNotNull = new Set(
    before.constraints.filter((c) => c.kind === "CHECK" && !c.notValid).map((c) => /^check (\S+) is not null$/.exec(c.body)?.[1]).filter((x): x is string => x !== undefined),
  );

  for (const a of after.columns) {
    let b = byName.get(a.name);
    const prev = after.columnPreviously[a.name];
    if (!b && prev && byName.has(prev) && !afterNames.has(prev)) {
      b = byName.get(prev)!;
      out.push(change(key, `columns.${a.name}`, "SQLPG205", b.name, a.name));
    }
    if (!b) {
      added.push(a);
      if (tableIsNew) continue;
      const identity = a.identity !== undefined;
      const storedGenerated = a.generated?.startsWith("stored ");
      const volatile = a.default !== undefined && VOLATILE.test(a.default);
      const text = `${a.name} ${a.type ?? ""}`.trim();
      if (identity || storedGenerated || volatile) {
        out.push(change(key, `columns.${a.name}`, "SQLPG202", undefined, text, { note: identity ? "an identity column" : storedGenerated ? "a STORED generated column" : `the default ${a.default} is volatile` }));
      } else if (a.notNull && a.default === undefined && !a.generated) out.push(change(key, `columns.${a.name}`, "SQLPG203", undefined, text));
      else out.push(change(key, `columns.${a.name}`, "SQLPG201", undefined, text));
      continue;
    }
    matched.add(b.name);
    const at = `columns.${a.name}`;
    if (b.type !== a.type) {
      // A serial spelling is an integer column with an owned sequence and a nextval default:
      // the change is classified by the integer types, and a change of the shorthand alone is a default.
      const bt = serialBase(b.type) ?? b.type ?? "";
      const at2 = serialBase(a.type) ?? a.type ?? "";
      const serial = serialBase(b.type) !== undefined || serialBase(a.type) !== undefined;
      if (bt === at2) out.push(change(key, `${at}.default`, "SQLPG209", b.type, a.type, { note: "the column gains or loses its owned sequence and nextval default" }));
      else {
        const rule = coercible(bt, at2) ? "SQLPG206" : family(bt) === family(at2) ? "SQLPG207" : "SQLPG208";
        const note = serial && serialBase(b.type) !== undefined && serialBase(a.type) !== undefined ? { note: `${bt} to ${at2}; the owned sequence is widened to ${at2} (ALTER SEQUENCE ... AS ${at2}, SQLPG265)` } : {};
        out.push(change(key, `${at}.type`, rule, b.type, a.type, note));
      }
    }
    if (b.default !== a.default) out.push(change(key, `${at}.default`, "SQLPG209", b.default, a.default));
    if (b.notNull !== a.notNull) {
      if (a.notNull) {
        const proven = checksProvingNotNull.has(a.name);
        out.push(change(key, `${at}.notNull`, "SQLPG210", "NULL", "NOT NULL", proven ? { class: "metadata", note: "a valid CHECK (column IS NOT NULL) proves it, so no scan (12 and later)" } : {}));
      } else out.push(change(key, `${at}.notNull`, "SQLPG211", "NOT NULL", "NULL"));
    }
    if (b.generated !== a.generated) {
      const virtual = a.generated?.startsWith("virtual ") && b.generated?.startsWith("virtual ");
      const extra: Partial<PgChange> = virtual
        ? { class: "metadata", note: "a VIRTUAL column (18) changes only the catalog" }
        : major < 17
          ? { class: "expand", note: `Postgres ${major} has no SET EXPRESSION: the column is dropped and added` }
          : {};
      out.push(change(key, `${at}.generated`, "SQLPG212", b.generated, a.generated, extra));
    }
    if (b.identity !== a.identity) out.push(change(key, `${at}.identity`, "SQLPG213", b.identity, a.identity));
    if (b.collate !== a.collate) out.push(change(key, `${at}.collate`, "SQLPG214", b.collate, a.collate));
    if (b.compression !== a.compression || b.storage !== a.storage) out.push(change(key, `${at}.storage`, "SQLPG215", [b.storage, b.compression].filter(Boolean).join(" ") || undefined, [a.storage, a.compression].filter(Boolean).join(" ") || undefined));
    if (b.comment !== a.comment) out.push(change(key, `${at}.comment`, "SQLPG216", b.comment, a.comment));
  }
  const dropped = before.columns.filter((c) => !matched.has(c.name));
  for (const b of dropped) {
    out.push(change(key, `columns.${b.name}`, "SQLPG204", `${b.name} ${b.type ?? ""}`.trim(), undefined, { destructive: true }));
    const twin = added.find((a) => a.type === b.type && a.position === b.position);
    if (twin) hints.push(`${key}: ${b.name} is dropped and ${twin.name} added with the same type in the same place; if it is a rename, write -- previously: ${b.name} on its line`);
  }
}

// ── Constraints ────────────────────────────────────────────────────────

/** The rule adding a constraint falls under. */
export function addConstraintRule(c: CanonicalConstraint): PgClassifierRuleId {
  if (c.notValid) return "SQLPG217";
  switch (c.kind) {
    case "CHECK":
      return "SQLPG218";
    case "FOREIGN KEY":
      return "SQLPG219";
    case "PRIMARY KEY":
    case "UNIQUE":
      return "SQLPG221";
    case "EXCLUDE":
      return "SQLPG222";
  }
}

function diffConstraints(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], domain: boolean): void {
  const remaining = [...before.constraints];
  const label = (c: CanonicalConstraint) => (c.name ? `${c.name}: ${c.body}` : c.body);
  for (const a of after.constraints) {
    const i = remaining.findIndex((b) => sameConstraint(a, b));
    if (i < 0) {
      out.push(change(key, `constraints.${a.name ?? a.kind.toLowerCase()}`, domain ? (a.notValid ? "SQLPG217" : "SQLPG262") : addConstraintRule(a), undefined, label(a)));
      continue;
    }
    const b = remaining.splice(i, 1)[0]!;
    if (b.notValid && !a.notValid) out.push(change(key, `constraints.${a.name ?? b.name ?? a.kind.toLowerCase()}`, "SQLPG220", "NOT VALID", "VALID"));
    if (!b.notValid && a.notValid) out.push(change(key, `constraints.${a.name ?? b.name ?? a.kind.toLowerCase()}`, "SQLPG216", "VALID", "NOT VALID", { note: "a validated constraint stays validated; NOT VALID only matters when it is added" }));
    if (b.comment !== a.comment) out.push(change(key, `constraints.${a.name ?? b.name}.comment`, "SQLPG216", b.comment, a.comment));
  }
  for (const b of remaining) out.push(change(key, `constraints.${b.name ?? b.kind.toLowerCase()}`, domain ? "SQLPG263" : "SQLPG223", label(b), undefined));
}

// ── Objects ────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v));

/**
 * The clauses chant does not read (#3872), compared as text: one the
 * declaration has and the server does not, or has differently, is a change
 * to review (SQLPG299); one only the server prints is a hint, since a
 * default a newer server prints cannot be told from a clause removed.
 */
function diffUnparsed(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], hints: string[]): void {
  const b = (before.fields.unparsed as Record<string, string> | undefined) ?? {};
  const a = (after.fields.unparsed as Record<string, string> | undefined) ?? {};
  for (const clause of Object.keys(a)) {
    if (b[clause] !== a[clause]) out.push(change(key, `unparsed.${clause}`, "SQLPG299", b[clause], a[clause], { note: "chant does not read this clause; review the change" }));
  }
  for (const clause of Object.keys(b)) {
    if (!(clause in a)) hints.push(`${key}: the current definition has ${clause} (${b[clause]}), a clause chant does not read and the declaration does not have; it is not compared`);
  }
}

/** The kinds (#3911) whose definition has no ALTER: a change is a drop and a create, or (an aggregate's) CREATE OR REPLACE. */
const REPLACED_KINDS: ReadonlySet<string> = new Set(["composite", "range", "aggregate", "collation", "cast", "eventTrigger", "operator", "operatorClass", "operatorFamily", "statistics"]);

/** What each of {@link REPLACED_KINDS} compares besides its name and comment. */
const DEFINITION: Readonly<Record<string, readonly string[]>> = {
  composite: ["attributeDefs"],
  range: ["subtype", "subtypeOpclass", "collation", "canonical", "subtypeDiff", "multirange"],
  aggregate: ["definition"],
  collation: ["provider", "lcCollate", "lcCtype", "locale", "nondeterministic", "rules"],
  cast: ["castMethod", "function", "context"],
  eventTrigger: ["event", "tags", "function"],
  operator: ["definition"],
  // A class's members, type, family and default flag have no ALTER; a family has no definition besides its name and method (its identity).
  operatorClass: ["default", "dataType", "family", "items"],
  operatorFamily: [],
  statistics: ["table", "kinds", "targets"],
};

/** The kinds (#3911) the server alters in place, with the fields that cannot be altered (the object is dropped and created) and those that can. */
const ALTERED_KINDS: Readonly<Record<string, { recreate: readonly string[]; inPlace: readonly string[]; rule?: PgClassifierRuleId }>> = {
  foreignDataWrapper: { recreate: [], inPlace: ["handler", "validator", "options"] },
  foreignServer: { recreate: ["serverType", "wrapper"], inPlace: ["version", "options"] },
  publication: { recreate: ["allTables"], inPlace: ["tables", "schemas", "publish", "viaRoot", "generatedColumns"] },
  // ALTER TEXT SEARCH DICTIONARY sets options and cannot change the template; ALTER TEXT SEARCH CONFIGURATION maps token types and cannot change the parser (SQLPG305).
  textSearchDictionary: { recreate: ["template"], inPlace: ["options"], rule: "SQLPG305" },
  textSearchConfiguration: { recreate: ["parser"], inPlace: ["mappings"], rule: "SQLPG305" },
};

/**
 * A foreign data wrapper's, foreign server's or publication's change: the
 * comment and each field ALTER reaches in place (SQLPG303); a field it does
 * not reach (a server's type and wrapper, a publication's FOR ALL TABLES) by
 * dropping and creating the object (SQLPG300), refused while something
 * depends on it (SQLPG301).
 */
function diffAltered(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[]): void {
  if (!same(before.fields.comment, after.fields.comment)) out.push(change(key, "comment", "SQLPG216", show(before.fields.comment), show(after.fields.comment)));
  const { recreate, inPlace, rule = "SQLPG303" } = ALTERED_KINDS[after.kind]!;
  const replaced = recreate.filter((k) => !same(before.fields[k], after.fields[k]));
  // An object that lives in a schema is another object under another name: a rename between builds is a drop and a create.
  if (after.schema !== undefined && (before.schema !== after.schema || before.name !== after.name)) replaced.unshift("name");
  if (replaced.length > 0) {
    const value = (o: PgDiffObject, k: string) => (k === "name" ? qualified(o) : (show(o.fields[k]) ?? "-"));
    const was = replaced.map((k) => `${k} ${value(before, k)}`).join("; ");
    const now = replaced.map((k) => `${k} ${value(after, k)}`).join("; ");
    if (before.dependents && before.dependents.length > 0) {
      out.push(change(key, replaced.join(", "), "SQLPG301", was, now, { note: `${before.dependents.join(", ")} depend${before.dependents.length === 1 ? "s" : ""} on it` }));
    } else out.push(change(key, replaced.join(", "), "SQLPG300", was, now));
    return;
  }
  for (const k of inPlace) if (!same(before.fields[k], after.fields[k])) out.push(change(key, k, rule, show(before.fields[k]), show(after.fields[k])));
}

/**
 * Which of an operator's attributes `ALTER OPERATOR ... SET` can change from
 * what the server holds (the Postgres 18 page, with the supported majors):
 * RESTRICT and JOIN on every major, set or removed; from 17 COMMUTATOR and
 * NEGATOR when the operator has none, and HASHES and MERGES when off, never
 * back. Anything else about the definition is dropped and created.
 */
function operatorAlterable(key: string, before: Record<string, unknown>, after: Record<string, unknown>, major: number): boolean {
  if (key === "restrict" || key === "join") return true;
  if (major < 17) return false;
  if (key === "commutator" || key === "negator") return before[key] === undefined && after[key] !== undefined;
  if (key === "hashes" || key === "merges") return before[key] === undefined && after[key] === "true";
  return false;
}

/** An operator's change: in place (SQLPG304) when every attribute that changed is one ALTER OPERATOR reaches, else dropped and created like the other kinds without an ALTER. */
function diffOperator(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], major: number): void {
  const bo = (before.fields.definition ?? {}) as Record<string, unknown>;
  const ao = (after.fields.definition ?? {}) as Record<string, unknown>;
  const renamed = before.schema !== after.schema || before.name !== after.name || before.signature !== after.signature;
  // In the order the page lists them, so the statement reads the same whatever the order the options were written in.
  const ORDER = ["restrict", "join", "commutator", "negator", "hashes", "merges"];
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  const changed = [...new Set([...Object.keys(bo), ...Object.keys(ao)])].filter((k) => !same(bo[k], ao[k])).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  if (renamed || !changed.every((k) => operatorAlterable(k, bo, ao, major))) {
    diffReplaced(key, before, after, out);
    return;
  }
  if (!same(before.fields.comment, after.fields.comment)) out.push(change(key, "comment", "SQLPG216", show(before.fields.comment), show(after.fields.comment)));
  const note = major < 17 ? undefined : "from 17 ALTER OPERATOR also sets a commutator's or negator's own commutator or negator";
  for (const k of changed) out.push(change(key, `definition.${k}`, "SQLPG304", show(bo[k]), show(ao[k]), note && (k === "commutator" || k === "negator") ? { note } : {}));
}

/**
 * A foreign table's columns, as ALTER FOREIGN TABLE changes them (SQLPG306):
 * all catalog changes, none reading the remote side. A column is its name
 * (a rename is a drop and an add); its comment is the generic comment rule.
 */
function diffForeignColumns(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[]): void {
  const byName = new Map(before.columns.map((c) => [c.name, c]));
  const afterNames = new Set(after.columns.map((c) => c.name));
  for (const b of before.columns) if (!afterNames.has(b.name)) out.push(change(key, `columns.${b.name}`, "SQLPG306", `${b.name} ${b.type ?? ""}`.trim(), undefined));
  for (const a of after.columns) {
    const b = byName.get(a.name);
    if (!b) {
      out.push(change(key, `columns.${a.name}`, "SQLPG306", undefined, `${a.name} ${a.type ?? ""}`.trim()));
      continue;
    }
    const at = `columns.${a.name}`;
    if (b.type !== a.type) out.push(change(key, `${at}.type`, "SQLPG306", b.type, a.type));
    if (b.collate !== a.collate) out.push(change(key, `${at}.collate`, "SQLPG306", b.collate, a.collate));
    if (b.default !== a.default) out.push(change(key, `${at}.default`, "SQLPG306", b.default, a.default));
    if (b.notNull !== a.notNull) out.push(change(key, `${at}.notNull`, "SQLPG306", b.notNull ? "NOT NULL" : "NULL", a.notNull ? "NOT NULL" : "NULL"));
    if (!same(b.options, a.options)) out.push(change(key, `${at}.options`, "SQLPG306", show(b.options), show(a.options)));
    if (b.comment !== a.comment) out.push(change(key, `${at}.comment`, "SQLPG216", b.comment, a.comment));
  }
}

/** A foreign table's CHECK constraints: a dropped one first, so a constraint replaced under its name is dropped before it is added. */
function diffForeignConstraints(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[]): void {
  const label = (c: CanonicalConstraint) => (c.name ? `${c.name}: ${c.body}` : c.body);
  const remaining = [...before.constraints];
  const added: CanonicalConstraint[] = [];
  const comments: PgChange[] = [];
  for (const a of after.constraints) {
    const i = remaining.findIndex((b) => sameConstraint(a, b));
    if (i < 0) {
      added.push(a);
      continue;
    }
    const b = remaining.splice(i, 1)[0]!;
    if (b.comment !== a.comment) comments.push(change(key, `constraints.${a.name ?? b.name}.comment`, "SQLPG216", b.comment, a.comment));
  }
  for (const b of remaining) out.push(change(key, `constraints.${b.name ?? b.kind.toLowerCase()}`, "SQLPG306", label(b), undefined));
  for (const a of added) out.push(change(key, `constraints.${a.name ?? a.kind.toLowerCase()}`, "SQLPG306", undefined, label(a)));
  out.push(...comments);
}

/**
 * A type's, aggregate's, collation's, cast's or event trigger's change: its
 * comment in place; its definition by CREATE OR REPLACE AGGREGATE where that
 * keeps the aggregate's result, else dropped and created (SQLPG300), or
 * refused while something depends on it (SQLPG301).
 */
function diffReplaced(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[]): void {
  if (!same(before.fields.comment, after.fields.comment)) out.push(change(key, "comment", "SQLPG216", show(before.fields.comment), show(after.fields.comment)));
  const changed = DEFINITION[after.kind]!.filter((k) => !same(before.fields[k], after.fields[k]));
  if (before.schema !== after.schema || before.name !== after.name || before.signature !== after.signature) changed.unshift("name");
  if (changed.length === 0) return;
  const was = changed.map((k) => `${k} ${k === "name" ? qualified(before) : (show(before.fields[k]) ?? "-")}`).join("; ");
  const now = changed.map((k) => `${k} ${k === "name" ? qualified(after) : (show(after.fields[k]) ?? "-")}`).join("; ");
  const bo = (before.fields.definition ?? {}) as Record<string, unknown>;
  const ao = (after.fields.definition ?? {}) as Record<string, unknown>;
  const replaceable = after.kind === "aggregate" && !changed.includes("name") && same(bo.stype, ao.stype) && same(bo.finalfunc, ao.finalfunc) && same(bo.hypothetical, ao.hypothetical);
  const what = changed.join(", ");
  if (replaceable) out.push(change(key, what, "SQLPG302", was, now, { note: "CREATE OR REPLACE AGGREGATE" }));
  else if (before.dependents && before.dependents.length > 0) {
    out.push(change(key, what, "SQLPG301", was, now, { note: `${before.dependents.join(", ")} depend${before.dependents.length === 1 ? "s" : ""} on it` }));
  } else out.push(change(key, what, "SQLPG300", was, now));
}

function diffObject(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], hints: string[], major: number): void {
  diffUnparsed(key, before, after, out, hints);
  if (before.kind !== after.kind) {
    out.push(change(key, "kind", "SQLPG268", before.kind, after.kind));
    return;
  }
  const f = (name: string) => [before.fields[name], after.fields[name]] as const;
  const field = (name: string, rule: PgClassifierRuleId, extra: Partial<PgChange> = {}) => {
    const [b, a] = f(name);
    if (!same(b, a)) out.push(change(key, name, rule, show(b), show(a), extra));
  };
  if (after.kind === "operator") {
    diffOperator(key, before, after, out, major);
    return;
  }
  // A foreign table moved to another server is another table: ALTER FOREIGN TABLE has no SERVER action.
  if (after.kind === "foreignTable" && before.schema === after.schema && before.name === after.name && !same(before.fields.server, after.fields.server)) {
    out.push(change(key, "server", before.dependents && before.dependents.length > 0 ? "SQLPG301" : "SQLPG300", show(before.fields.server), show(after.fields.server), before.dependents && before.dependents.length > 0 ? { note: `${before.dependents.join(", ")} depend${before.dependents.length === 1 ? "s" : ""} on it` } : {}));
    return;
  }
  if (REPLACED_KINDS.has(after.kind)) {
    // A cast is named by its types, and an aggregate's argument types are its identity: either changed, between two builds, is another object.
    if (after.kind === "cast" && before.name !== after.name) {
      out.push(change(key, "name", before.dependents?.length ? "SQLPG301" : "SQLPG300", before.name, after.name));
      return;
    }
    diffReplaced(key, before, after, out);
    return;
  }
  if (after.kind in ALTERED_KINDS) {
    diffAltered(key, before, after, out);
    return;
  }
  if (before.schema !== after.schema || before.name !== after.name) {
    out.push(change(key, "name", after.kind === "index" ? "SQLPG229" : "SQLPG228", qualified(before), qualified(after)));
  }
  field("comment", "SQLPG216");
  switch (after.kind) {
    case "schema":
      field("authorization", "SQLPG267");
      break;
    case "extension":
      field("version", "SQLPG266");
      field("schema", "SQLPG266");
      break;
    case "sequence":
      field("options", "SQLPG265");
      field("ownedBy", "SQLPG265");
      field("unlogged", "SQLPG225", { class: "metadata", note: "a sequence's own row only" });
      break;
    case "enum": {
      const b = (before.fields.labels as string[] | undefined) ?? [];
      const a = (after.fields.labels as string[] | undefined) ?? [];
      if (!same(b, a)) {
        // Labels only added, wherever they go, keep every old label in order.
        const kept = a.filter((l) => b.includes(l));
        out.push(change(key, "labels", same(kept, b) ? "SQLPG260" : "SQLPG261", b.join(", "), a.join(", ")));
      }
      break;
    }
    case "domain":
      field("dataType", "SQLPG264");
      field("collate", "SQLPG264");
      field("default", "SQLPG263");
      if (!same(f("notNull")[0], f("notNull")[1])) out.push(change(key, "notNull", after.fields.notNull ? "SQLPG262" : "SQLPG263", show(before.fields.notNull), show(after.fields.notNull)));
      diffConstraints(key, before, after, out, true);
      break;
    case "index": {
      const definition = ["table", "unique", "method", "elements", "include", "nullsNotDistinct", "where"];
      const changed = definition.filter((k) => !same(before.fields[k], after.fields[k]));
      if (changed.length > 0) {
        out.push(change(key, changed.join(", "), "SQLPG243", changed.map((k) => `${k} ${show(before.fields[k]) ?? "-"}`).join("; "), changed.map((k) => `${k} ${show(after.fields[k]) ?? "-"}`).join("; ")));
      } else {
        field("with", "SQLPG224");
        field("tablespace", "SQLPG226");
      }
      break;
    }
    case "view":
    case "materializedView": {
      const b = before.outputs ?? [];
      const a = after.outputs ?? [];
      const appends = a.length >= b.length && b.every((o, i) => a[i] === o);
      if (!same(before.fields.query, after.fields.query) || !same(b, a)) {
        if (after.kind === "materializedView") out.push(change(key, "query", "SQLPG252", show(before.fields.query), show(after.fields.query)));
        else out.push(change(key, "query", appends ? "SQLPG250" : "SQLPG251", show(before.fields.query), show(after.fields.query), appends ? {} : { note: `columns ${b.join(", ")} -> ${a.join(", ")}` }));
      }
      field("with", "SQLPG253");
      field("checkOption", "SQLPG253");
      field("withData", "SQLPG252");
      field("columnComments", "SQLPG216");
      break;
    }
    case "function":
    case "procedure": {
      // CREATE OR REPLACE cannot change the result, the OUT parameters, an input parameter's name, a removed default or a window function's kind.
      const ba = (before.fields.args as string[] | undefined) ?? [];
      const aa = (after.fields.args as string[] | undefined) ?? [];
      const inputName = (a: string) => (/^(in|inout|variadic) /.test(a) ? a.split(" ")[1] : undefined);
      const reasons: string[] = [];
      // Between two builds, the same export with other parameter types is another function on the server.
      if (before.signature !== after.signature) reasons.push(`the parameter types ${before.signature} -> ${after.signature}`);
      if (!same(before.fields.returns, after.fields.returns)) reasons.push(`the result ${show(before.fields.returns) ?? "-"} -> ${show(after.fields.returns) ?? "-"}`);
      const outs = (l: string[]) => l.filter((a) => /^(out|inout) /.test(a));
      if (!same(outs(ba), outs(aa))) reasons.push("the output parameters");
      if (ba.some((a, i) => aa[i] !== undefined && inputName(a) !== inputName(aa[i]!) && /^(in|inout|variadic) /.test(aa[i]!))) reasons.push("a parameter's name");
      if (ba.some((a, i) => / default /.test(a) && aa[i] !== undefined && !/ default /.test(aa[i]!))) reasons.push("a parameter's default is removed");
      if (!same(before.fields.window, after.fields.window)) reasons.push("WINDOW");
      const definition = ["args", "returns", "language", "body", "link", "securityDefiner", "set", "transform", "volatility", "strict", "leakproof", "parallel", "cost", "rows", "support", "window"];
      const changed = definition.filter((k) => !same(before.fields[k], after.fields[k]));
      if (changed.length === 0 && reasons.length === 0) break;
      if (changed.length === 0) changed.push("args");
      const what = changed.join(", ");
      if (reasons.length === 0) out.push(change(key, what, "SQLPG280", undefined, undefined, { note: `CREATE OR REPLACE ${after.kind.toUpperCase()}` }));
      else if (before.dependents && before.dependents.length > 0) {
        out.push(change(key, what, "SQLPG282", undefined, undefined, { note: `${reasons.join(", ")} changes, and ${before.dependents.join(", ")} depend${before.dependents.length === 1 ? "s" : ""} on it` }));
      } else out.push(change(key, what, "SQLPG281", undefined, undefined, { note: `${reasons.join(", ")} changes, which CREATE OR REPLACE refuses` }));
      break;
    }
    case "trigger": {
      const definition = ["table", "constraint", "timing", "events", "forEach", "when", "function", "args", "from", "deferrable", "initiallyDeferred", "referencing"];
      const changed = definition.filter((k) => !same(before.fields[k], after.fields[k]));
      if (changed.length > 0) {
        out.push(
          change(key, changed.join(", "), "SQLPG284", changed.map((k) => `${k} ${show(before.fields[k]) ?? "-"}`).join("; "), changed.map((k) => `${k} ${show(after.fields[k]) ?? "-"}`).join("; "), after.fields.constraint || before.fields.constraint || !same(before.fields.table, after.fields.table) ? { note: "dropped and created in one transaction: a constraint trigger has no OR REPLACE, and OR REPLACE keeps a trigger on its table" } : {}),
        );
      }
      break;
    }
    case "policy": {
      // ALTER POLICY sets the roles, USING and WITH CHECK; the command and AS RESTRICTIVE are fixed, and neither expression can be taken away.
      const definition = ["table", "restrictive", "command", "roles", "using", "check"];
      const changed = definition.filter((k) => !same(before.fields[k], after.fields[k]));
      if (changed.length === 0) break;
      const recreate =
        !same(before.fields.table, after.fields.table) ||
        !same(before.fields.restrictive, after.fields.restrictive) ||
        !same(before.fields.command, after.fields.command) ||
        (before.fields.using !== undefined && after.fields.using === undefined) ||
        (before.fields.check !== undefined && after.fields.check === undefined);
      out.push(
        change(key, changed.join(", "), "SQLPG291", changed.map((k) => `${k} ${show(before.fields[k]) ?? "-"}`).join("; "), changed.map((k) => `${k} ${show(after.fields[k]) ?? "-"}`).join("; "), recreate ? { note: "dropped and created in one transaction: ALTER POLICY cannot change its command, AS RESTRICTIVE or table, or take an expression away" } : {}),
      );
      break;
    }
    case "role":
      field("attributes", "SQLPG294");
      field("connectionLimit", "SQLPG294");
      break;
    case "foreignTable":
      diffForeignColumns(key, before, after, out);
      diffForeignConstraints(key, before, after, out);
      field("options", "SQLPG306");
      break;
    case "table":
      if (!same(before.fields.rowSecurity, after.fields.rowSecurity) || !same(before.fields.forceRowSecurity, after.fields.forceRowSecurity)) {
        const state = (o: PgDiffObject) => (o.fields.rowSecurity ? (o.fields.forceRowSecurity ? "enabled, forced" : "enabled") : o.fields.forceRowSecurity ? "disabled, forced" : "disabled");
        out.push(change(key, "rowSecurity", "SQLPG293", state(before), state(after), after.fields.rowSecurity && !before.fields.rowSecurity ? { note: "with row-level security on, a role the table's policies do not let in sees no rows" } : {}));
      }
      diffColumns(key, before, after, out, hints, false, major);
      diffConstraints(key, before, after, out, false);
      field("with", "SQLPG224");
      field("unlogged", "SQLPG225");
      field("using", "SQLPG226", major < 15 ? { class: "expand", note: `Postgres ${major} has no SET ACCESS METHOD: the table is created again` } : {});
      field("tablespace", "SQLPG226");
      for (const k of ["partitionBy", "partitionOf", "partitionBound", "inherits"]) field(k, "SQLPG227");
      break;
  }
}

/** Whether an object is created by this plan in the same run (its index then needs no CONCURRENTLY). */
function createdTables(matches: ReturnType<typeof matchByIdentity<PgDiffObject>>): Set<string> {
  const out = new Set<string>();
  for (const m of matches) if (m.kind === "created" && m.after.canonical.kind === "table") out.add(qualified(m.after.canonical));
  return out;
}

/**
 * Classify every change from `before` to `after`. Objects another tool owns
 * (an ORM's revision table) are never proposed for a drop.
 */
/**
 * Which object of `before` each object of `after` is: by key, else by a
 * `-- previously:` hint naming the old one. The diff and the applier
 * (`../apply/`) match the same way.
 */
export function matchPgObjects(before: readonly PgSchemaObject[], after: readonly PgSchemaObject[]): ReturnType<typeof matchByIdentity<PgDiffObject>> {
  return matchByIdentity(before, after, {
    qualified: (o) => `${pgNamespace(o.kind)} ${o.schema ? `${o.schema}.` : ""}${o.name}${o.signature ?? ""}`,
    previously: (o) => o.previously,
    previousNames: (o, prev) => {
      const space = pgNamespace(o.kind);
      const sig = o.signature ?? "";
      return [`${space} ${prev}${sig}`, ...(o.schema && !prev.includes(".") ? [`${space} ${o.schema}.${prev}${sig}`] : [])];
    },
  });
}

export function diffPgSchemas(beforeAll: readonly PgSchemaObject[], afterAll: readonly PgSchemaObject[], options: PgDiffOptions = {}): PgSchemaDiff {
  const major = options.major ?? POSTGRES_LATEST_MAJOR;
  // Grants and default privileges are compared as the access they add up to, below, not one declaration against another.
  const before = beforeAll.filter((o) => !ACCESS_KINDS.has(o.canonical.kind));
  const after = afterAll.filter((o) => !ACCESS_KINDS.has(o.canonical.kind));
  const matches = matchPgObjects(before, after);
  const newTables = createdTables(matches);
  const changes: PgChange[] = [];
  const hints: string[] = [];
  for (const m of matches) {
    if (m.kind === "created") {
      const o = m.after.canonical;
      if (o.kind === "index" && !newTables.has(String(o.fields.table))) {
        changes.push(change(m.after.key, "index", o.concurrently ? "SQLPG240" : "SQLPG241", undefined, qualified(o)));
      } else if (o.kind === "trigger" && !newTables.has(String(o.fields.table))) {
        changes.push(change(m.after.key, "trigger", "SQLPG283", undefined, `${o.name}${o.signature ?? ""}`));
      } else if (o.kind === "policy" && !newTables.has(String(o.fields.table))) {
        changes.push(change(m.after.key, "policy", "SQLPG290", undefined, `${o.name}${o.signature ?? ""}`));
      } else changes.push(change(m.after.key, o.kind, "SQLPG200", undefined, qualified(o)));
    } else if (m.kind === "dropped") {
      const o = m.before.canonical;
      if (o.foreign) {
        hints.push(`${m.before.key} is kept by ${o.foreign}; it is not chant's to drop and is left alone`);
        continue;
      }
      if (o.kind === "role") {
        hints.push(`role ${o.name} is no longer declared; a role is the cluster's and is never dropped`);
        continue;
      }
      const destructive = o.kind === "table" || o.kind === "materializedView" || o.kind === "sequence";
      const rule = o.kind === "index" ? "SQLPG242" : o.kind === "trigger" ? "SQLPG285" : o.kind === "policy" ? "SQLPG292" : "SQLPG270";
      changes.push(change(m.before.key, o.kind, rule, o.kind === "trigger" || o.kind === "policy" ? `${o.name}${o.signature ?? ""}` : qualified(o), undefined, destructive ? { destructive: true } : {}));
    } else diffObject(m.after.key, m.before.canonical, m.after.canonical, changes, hints, major);
  }
  const access = options.access === false ? [] : buildAccessChanges(beforeAll, afterAll, major);
  changes.push(...access.map((a) => a.change));
  return { changes, hints, refused: changes.filter((c) => c.class === "expand"), ...(access.length > 0 ? { access } : {}) };
}

/**
 * The access change between two builds: on what the newer build decides. An
 * object only it declares starts from what Postgres gives a new one; an
 * object only the older one declared is dropped with its privileges.
 */
function buildAccessChanges(before: readonly PgSchemaObject[], after: readonly PgSchemaObject[], major: number): AccessChange[] {
  const b = declaredAccess(before, { major });
  const a = declaredAccess(after, { major });
  const decided = new Set(a.targets.map(targetKey));
  const known = new Set(b.targets.map(targetKey));
  const from = new Map([...b.state].filter(([, e]) => decided.has(targetKey(e.target))));
  for (const t of a.targets) {
    if (known.has(targetKey(t)) || t.kind === "default" || t.kind === "column") continue;
    for (const e of builtinEntries(t.kind)) {
      const key = entryKey(t, e.grantee);
      from.set(key, { target: t, grantee: e.grantee, privileges: new Map([...(from.get(key)?.privileges ?? []), [e.privilege, false]]) });
    }
  }
  return diffAccess(from, a.state, a.exportsOf);
}
