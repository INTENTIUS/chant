/**
 * The diff between two ClickHouse schemas, each change classified.
 *
 * Identity (#3047 question 3):
 *
 * - An object is identified by its export name between two revisions of the
 *   declarations, so a changed name in the SQL under the same export is a
 *   rename, not a drop and a create. Against a live server, which has no
 *   export names, it is identified by `database.name`, and a declaration
 *   carrying `-- previously: <old name>` before its CREATE is matched to the
 *   object of that name.
 * - A column is identified by its name: the SQL form has no column key apart
 *   from the name. A column renamed in place says so with
 *   `-- previously: <old name>` on its line; without the hint a renamed
 *   column reads as a drop and an add, and the diff points that out when the
 *   two look alike.
 */

import { CLASSIFIER_RULES, type ChangeClass, type ClassifierRuleId } from "./rules";
import type { CanonicalColumn, CanonicalObject } from "./normalize";
import type { RebuildOpSuggestion } from "./rebuild-handoff";
import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";
import { classifiedChange, type ChangeSet, type ClassifiedChange } from "../../core/classifier";
import { changedEntries, matchByIdentity, type Keyed } from "../../core/diff";

export type SchemaObject = Keyed<CanonicalObject>;

export type Change = ClassifiedChange<ClassifierRuleId, ChangeClass>;

export interface SchemaDiff extends ChangeSet<Change> {
  /** The rebuilds a plan must refuse to make in place. */
  rebuilds: Change[];
  /** For each table refused as a rebuild, the rebuild migration Op to run instead (`./rebuild-handoff.ts`). */
  rebuildOps?: RebuildOpSuggestion[];
  /**
   * Objects on the server, in the declared databases, whose definition chant
   * cannot read (#3653): a plan names each one and fails rather than leave
   * it out.
   */
  unreadable?: UnreadableEntry[];
}

/** An object a plan could not read: `database.name`, its type and why. */
export interface UnreadableEntry {
  object: string;
  type: string;
  reason: string;
}

const qualified = (o: CanonicalObject) => (o.database ? `${o.database}.${o.name}` : o.name);

function change(object: string, field: string, rule: ClassifierRuleId, before?: unknown, after?: unknown, extra: Partial<Change> = {}): Change {
  return classifiedChange(CLASSIFIER_RULES, object, field, rule, before, after, extra);
}

/** The column names a key expression mentions. */
function keyColumns(o: CanonicalObject): Set<string> {
  const out = new Set<string>();
  for (const k of [o.orderBy, o.primaryKey ?? o.orderBy, o.partitionBy, o.sampleBy]) {
    for (const word of (k ?? "").split(" ")) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) out.add(word);
  }
  return out;
}

const elements = (key: string | undefined) => (key ? key.replace(/^\( (.*) \)$/, "$1").split(" , ") : []);

/** An ORDER BY change that only appends columns the same change adds (MODIFY ORDER BY). */
function appendsAddedColumns(before: string | undefined, after: string | undefined, added: Set<string>): boolean {
  const b = elements(before);
  const a = elements(after);
  if (a.length <= b.length || b.some((e, i) => a[i] !== e)) return false;
  return a.slice(b.length).every((e) => added.has(e));
}

function diffColumns(key: string, before: CanonicalObject, after: CanonicalObject, out: Change[], hints: string[]): Set<string> {
  const keys = keyColumns(before);
  const pk = new Set(elements(before.primaryKey ?? before.orderBy).flatMap((e) => e.split(" ")));
  const byName = new Map(before.columns.map((c) => [c.name, c]));
  const afterNames = new Set(after.columns.map((c) => c.name));
  const matched = new Set<string>();
  const added = new Set<string>();

  for (const a of after.columns) {
    let b = byName.get(a.name);
    if (!b && a.previously && byName.has(a.previously) && !afterNames.has(a.previously)) {
      b = byName.get(a.previously)!;
      out.push(change(key, `columns.${a.name}`, keys.has(b.name) ? "SQLCH213" : "SQLCH212", b.name, a.name));
    }
    if (!b) {
      added.add(a.name);
      out.push(change(key, `columns.${a.name}`, "SQLCH201", undefined, a.text));
      continue;
    }
    matched.add(b.name);
    const field = (f: string) => `columns.${a.name}.${f}`;
    if (a.type !== b.type || (a.nullable ?? false) !== (b.nullable ?? false)) {
      out.push(change(key, field("type"), pk.has(b.name) || keys.has(b.name) ? "SQLCH211" : "SQLCH210", b.type, a.type));
    }
    if (a.defaultKind !== b.defaultKind || a.defaultExpr !== b.defaultExpr) {
      out.push(change(key, field("default"), "SQLCH207", [b.defaultKind, b.defaultExpr].filter(Boolean).join(" "), [a.defaultKind, a.defaultExpr].filter(Boolean).join(" ")));
    }
    if (a.codec !== b.codec) out.push(change(key, field("codec"), "SQLCH208", b.codec, a.codec));
    if (a.ttl !== b.ttl) out.push(change(key, field("ttl"), "SQLCH205", b.ttl, a.ttl));
    if (a.comment !== b.comment) out.push(change(key, field("comment"), "SQLCH203", b.comment, a.comment));
  }

  const dropped = before.columns.filter((c) => !matched.has(c.name));
  for (const b of dropped) {
    out.push(change(key, `columns.${b.name}`, keys.has(b.name) ? "SQLCH213" : "SQLCH202", b.text, undefined, { destructive: true }));
    const twin = after.columns.find((a) => added.has(a.name) && a.type === b.type && a.position === b.position);
    if (twin) {
      hints.push(
        `${key}: column ${b.name} is dropped and ${twin.name} added with the same type in the same place. ` +
          `If it is a rename, write \`-- previously: ${b.name}\` on ${twin.name}'s line.`,
      );
    }
  }

  // Order, among the columns both sides have (a renamed column by its old name).
  const beforeOrder = before.columns.map((c) => c.name).filter((n) => matched.has(n));
  const afterOrder = after.columns
    .map((c) => (byName.has(c.name) ? c.name : c.previously && matched.has(c.previously) ? c.previously : undefined))
    .filter((n): n is string => n !== undefined && matched.has(n));
  if (beforeOrder.join(",") !== afterOrder.join(",")) out.push(change(key, "columns.order", "SQLCH209", beforeOrder.join(", "), afterOrder.join(", ")));
  return added;
}

function diffMap(key: string, field: string, before: Record<string, string>, after: Record<string, string>, rule: ClassifierRuleId, out: Change[]) {
  for (const name of changedEntries(before, after)) out.push(change(key, `${field}.${name}`, rule, before[name], after[name]));
}

function diffObject(key: string, before: CanonicalObject, after: CanonicalObject, out: Change[], hints: string[]): void {
  if (before.kind !== after.kind) {
    out.push(change(key, "kind", "SQLCH224", before.kind, after.kind, { destructive: before.kind === "table" }));
    return;
  }
  if (qualified(before) !== qualified(after)) {
    out.push(change(key, "name", before.kind === "database" ? "SQLCH231" : "SQLCH230", qualified(before), qualified(after)));
  }
  if (before.comment !== after.comment) out.push(change(key, "comment", "SQLCH203", before.comment, after.comment));

  if (before.kind === "database") {
    // A declaration with no ENGINE takes the server's default database engine
    // (Atomic; Replicated on Cloud), whatever the server says it is (#3645).
    if (after.engine !== undefined && before.engine !== after.engine) out.push(change(key, "engine", "SQLCH232", before.engine, after.engine));
    return;
  }

  if (before.kind === "user" || before.kind === "role" || before.kind === "rowPolicy") {
    const rule = before.kind === "user" ? "SQLCH271" : before.kind === "role" ? "SQLCH270" : "SQLCH272";
    const b = before.access ?? {};
    const a = after.access ?? {};
    const order = ["identified", "host", "validUntil", "defaultRole", "defaultDatabase", "grantees", "settings", "as", "for", "using", "to"];
    const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) => order.indexOf(x) - order.indexOf(y));
    for (const field of fields) {
      // A user's authentication is compared only when the declaration says it.
      if (before.kind === "user" && field === "identified" && a.identified === undefined) continue;
      if (b[field] !== a[field]) out.push(change(key, field, rule, b[field], a[field]));
    }
    return;
  }

  if (before.kind === "grants") {
    const b = before.access ?? {};
    const a = after.access ?? {};
    for (const atom of Object.keys(b)) if (!(atom in a)) out.push(change(key, `grants.${atom}`, "SQLCH274", atom, undefined));
    for (const atom of Object.keys(a)) if (!(atom in b)) out.push(change(key, `grants.${atom}`, "SQLCH273", undefined, atom));
    return;
  }

  if (before.kind === "function") {
    if (before.lambda !== after.lambda) out.push(change(key, "lambda", "SQLCH260", before.lambda, after.lambda));
    return;
  }

  if (before.kind === "dictionary") {
    diffDictionary(key, before, after, out);
    return;
  }

  if (before.kind === "view") {
    if (before.select !== after.select) out.push(change(key, "select", "SQLCH240", before.select, after.select));
    return;
  }

  if (before.kind === "materializedView") {
    if (before.to !== after.to) out.push(change(key, "to", "SQLCH242", before.to, after.to));
    if (before.select !== after.select) out.push(change(key, "select", "SQLCH241", before.select, after.select, { note: "rows already in the target are not recomputed" }));
    if (before.refresh !== after.refresh) out.push(change(key, "refresh", "SQLCH244", before.refresh, after.refresh));
    for (const f of ["engine", "orderBy", "primaryKey", "partitionBy", "sampleBy", "ttl"] as const) {
      if (before[f] !== after[f]) out.push(change(key, f, "SQLCH243", before[f], after[f]));
    }
    return;
  }

  // A table.
  if (before.engine !== after.engine) out.push(change(key, "engine", "SQLCH223", before.engine, after.engine));
  const added = diffColumns(key, before, after, out, hints);

  const beforePk = before.primaryKey ?? before.orderBy;
  const afterPk = after.primaryKey ?? after.orderBy;
  if (before.orderBy !== after.orderBy) {
    const append = appendsAddedColumns(before.orderBy, after.orderBy, added) && beforePk === afterPk;
    out.push(
      change(key, "orderBy", append ? "SQLCH216" : "SQLCH220", before.orderBy, after.orderBy, {
        ...(appendsAddedColumns(before.orderBy, after.orderBy, added) && beforePk !== afterPk
          ? { note: `appending new columns keeps the primary key; declare PRIMARY KEY ${beforePk} to make this an ALTER` }
          : {}),
      }),
    );
  }
  if (beforePk !== afterPk && !(before.orderBy !== after.orderBy && before.primaryKey === undefined && after.primaryKey === undefined)) {
    out.push(change(key, "primaryKey", "SQLCH221", beforePk, afterPk));
  }
  if (before.partitionBy !== after.partitionBy) out.push(change(key, "partitionBy", "SQLCH222", before.partitionBy, after.partitionBy));
  if (before.sampleBy !== after.sampleBy) out.push(change(key, "sampleBy", "SQLCH217", before.sampleBy, after.sampleBy));
  if (before.ttl !== after.ttl) out.push(change(key, "ttl", "SQLCH205", before.ttl, after.ttl));

  for (const name of changedEntries(before.settings, after.settings)) {
    const spec = (MERGE_TREE_SETTINGS as Record<string, { readonly: boolean } | undefined>)[name];
    out.push(change(key, `settings.${name}`, spec?.readonly ? "SQLCH218" : "SQLCH206", before.settings[name], after.settings[name]));
  }
  diffMap(key, "indexes", before.indexes, after.indexes, "SQLCH204", out);
  diffMap(key, "projections", before.projections, after.projections, "SQLCH214", out);
  diffMap(key, "constraints", before.constraints, after.constraints, "SQLCH215", out);
}

/** A dictionary: every change but its comment replaces it (SQLCH245). */
function diffDictionary(key: string, before: CanonicalObject, after: CanonicalObject, out: Change[]): void {
  const attribute = (c: CanonicalColumn) =>
    [c.type, c.defaultExpr !== undefined ? `DEFAULT ${c.defaultExpr}` : "", c.expression !== undefined ? `EXPRESSION ${c.expression}` : "", c.flags ?? ""].filter(Boolean).join(" ");
  const b = new Map(before.columns.map((c) => [c.name, attribute(c)]));
  const a = new Map(after.columns.map((c) => [c.name, attribute(c)]));
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    if (b.get(name) !== a.get(name)) out.push(change(key, `columns.${name}`, "SQLCH245", b.get(name), a.get(name)));
  }
  const order = (o: CanonicalObject) => o.columns.map((c) => c.name).join(", ");
  if (order(before) !== order(after) && [...a.keys()].every((n) => b.has(n)) && a.size === b.size) out.push(change(key, "columns.order", "SQLCH245", order(before), order(after)));
  for (const f of ["primaryKey", "dataSource", "layout", "lifetime", "range"] as const) {
    if (before[f] !== after[f]) out.push(change(key, f, "SQLCH245", before[f], after[f]));
  }
  for (const name of changedEntries(before.settings, after.settings)) out.push(change(key, `settings.${name}`, "SQLCH245", before.settings[name], after.settings[name]));
}

/**
 * Diff two schemas. `before` and `after` are matched by key; an `after`
 * object whose key is new but whose `previously` names a `before` object
 * with no `after` counterpart is that object, renamed.
 */
export function diffSchemas(before: readonly SchemaObject[], after: readonly SchemaObject[]): SchemaDiff {
  const changes: Change[] = [];
  const hints: string[] = [];
  const matches = matchByIdentity(before, after, {
    qualified,
    // A function, a user, a role, a row policy and a grantee's grants are not renamed: one under a new name is a create.
    previously: (o) => (o.kind === "function" || o.kind === "user" || o.kind === "role" || o.kind === "rowPolicy" || o.kind === "grants" ? undefined : o.previously),
    previousNames: (o, prev) => [prev, `${o.database}.${prev}`],
  });
  for (const m of matches) {
    if (m.kind === "created") changes.push(change(m.after.key, "object", "SQLCH200", undefined, qualified(m.after.canonical)));
    else if (m.kind === "matched") diffObject(m.after.key, m.before.canonical, m.after.canonical, changes, hints);
    else if (m.before.canonical.foreign) {
      // A migration runner's history table (#3676): not chant's to drop.
      hints.push(`${qualified(m.before.canonical)} is kept by ${m.before.canonical.foreign}; it is not chant's to drop and is left alone`);
    } else {
      const b = m.before;
      changes.push(change(b.key, "object", "SQLCH250", qualified(b.canonical), undefined, { destructive: b.canonical.kind === "table" || b.canonical.kind === "materializedView" }));
    }
  }
  return { changes, rebuilds: changes.filter((c) => c.class === "rebuild"), hints };
}
