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
import { sameConstraint, type CanonicalColumn, type CanonicalConstraint } from "./normalize";
import type { PgDiffObject, PgSchemaObject } from "./schema";

export type PgChange = ClassifiedChange<PgClassifierRuleId, PgChangeClass>;

export interface PgSchemaDiff extends ChangeSet<PgChange> {
  /** The changes a plan refuses to make in place: expand and contract only. */
  refused: PgChange[];
}

const change = (object: string, field: string, rule: PgClassifierRuleId, before?: unknown, after?: unknown, extra: Partial<PgChange> = {}): PgChange =>
  classifiedChange(PG_CLASSIFIER_RULES, object, field, rule, before, after, extra);

const qualified = (o: PgDiffObject) => `${o.schema ? `${o.schema}.` : ""}${o.name}`;

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

function diffColumns(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], hints: string[], tableIsNew: boolean): void {
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
      const rule = coercible(b.type ?? "", a.type ?? "") ? "SQLPG206" : family(b.type ?? "") === family(a.type ?? "") ? "SQLPG207" : "SQLPG208";
      out.push(change(key, `${at}.type`, rule, b.type, a.type));
    }
    if (b.default !== a.default) out.push(change(key, `${at}.default`, "SQLPG209", b.default, a.default));
    if (b.notNull !== a.notNull) {
      if (a.notNull) {
        const proven = checksProvingNotNull.has(a.name);
        out.push(change(key, `${at}.notNull`, "SQLPG210", "NULL", "NOT NULL", proven ? { class: "metadata", note: "a valid CHECK (column IS NOT NULL) proves it, so no scan (12 and later)" } : {}));
      } else out.push(change(key, `${at}.notNull`, "SQLPG211", "NOT NULL", "NULL"));
    }
    if (b.generated !== a.generated) {
      out.push(
        change(key, `${at}.generated`, "SQLPG212", b.generated, a.generated, a.generated?.startsWith("virtual ") && b.generated?.startsWith("virtual ") ? { class: "metadata", note: "a VIRTUAL column (18) changes only the catalog" } : {}),
      );
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

function addConstraintRule(c: CanonicalConstraint): PgClassifierRuleId {
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

function diffObject(key: string, before: PgDiffObject, after: PgDiffObject, out: PgChange[], hints: string[]): void {
  if (before.kind !== after.kind) {
    out.push(change(key, "kind", "SQLPG268", before.kind, after.kind));
    return;
  }
  const f = (name: string) => [before.fields[name], after.fields[name]] as const;
  const field = (name: string, rule: PgClassifierRuleId, extra: Partial<PgChange> = {}) => {
    const [b, a] = f(name);
    if (!same(b, a)) out.push(change(key, name, rule, show(b), show(a), extra));
  };
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
    case "table":
      diffColumns(key, before, after, out, hints, false);
      diffConstraints(key, before, after, out, false);
      field("with", "SQLPG224");
      field("unlogged", "SQLPG225");
      field("using", "SQLPG226");
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
export function diffPgSchemas(before: readonly PgSchemaObject[], after: readonly PgSchemaObject[]): PgSchemaDiff {
  const matches = matchByIdentity(before, after, {
    qualified: (o) => `${o.kind === "schema" ? "schema" : o.kind === "extension" ? "extension" : o.kind === "enum" || o.kind === "domain" ? "type" : "relation"} ${qualified(o)}`,
    previously: (o) => o.previously,
    previousNames: (o, prev) => {
      const space = o.kind === "schema" ? "schema" : o.kind === "extension" ? "extension" : o.kind === "enum" || o.kind === "domain" ? "type" : "relation";
      return [`${space} ${prev}`, ...(o.schema && !prev.includes(".") ? [`${space} ${o.schema}.${prev}`] : [])];
    },
  });
  const newTables = createdTables(matches);
  const changes: PgChange[] = [];
  const hints: string[] = [];
  for (const m of matches) {
    if (m.kind === "created") {
      const o = m.after.canonical;
      if (o.kind === "index" && !newTables.has(String(o.fields.table))) {
        changes.push(change(m.after.key, "index", o.concurrently ? "SQLPG240" : "SQLPG241", undefined, qualified(o)));
      } else changes.push(change(m.after.key, o.kind, "SQLPG200", undefined, qualified(o)));
    } else if (m.kind === "dropped") {
      const o = m.before.canonical;
      if (o.foreign) {
        hints.push(`${m.before.key} is kept by ${o.foreign}; it is not chant's to drop and is left alone`);
        continue;
      }
      const destructive = o.kind === "table" || o.kind === "materializedView" || o.kind === "sequence";
      changes.push(change(m.before.key, o.kind, o.kind === "index" ? "SQLPG242" : "SQLPG270", qualified(o), undefined, destructive ? { destructive: true } : {}));
    } else diffObject(m.after.key, m.before.canonical, m.after.canonical, changes, hints);
  }
  return { changes, hints, refused: changes.filter((c) => c.class === "expand") };
}
