/**
 * What uses the migrated column, carried over to the new one (#3322).
 *
 * An index, a constraint or a view on the column binds the column by its
 * attribute number, not its name, so a swap of names at the switch would
 * leave it on the old column, and the contract could not drop that column
 * while something uses it. Each is made again on the new column before the
 * switch, under a working name, and the switch swaps the names:
 *
 * | On the old column | Before the switch | In the switch's transaction |
 * |---|---|---|
 * | an index | `CREATE INDEX CONCURRENTLY` on the new column | the old one dropped (a type change) or kept as `<name>__chant_old` (a rename), the new one renamed to the name |
 * | a primary key or unique constraint | its unique index built `CONCURRENTLY` | the old constraint dropped (or a rename's unique one kept as `__chant_old`), `ADD CONSTRAINT ... USING INDEX` |
 * | a check or foreign key, this table's or another's that references the column | added `NOT VALID`, then `VALIDATE` | the old one dropped, the new one renamed to the name |
 * | a view (and the views that read it) | nothing | dropped, then created again from its declaration once the columns are swapped, with its grants and owner |
 *
 * `CREATE INDEX CONCURRENTLY` reads the table without blocking writes, and
 * `VALIDATE CONSTRAINT` holds SHARE UPDATE EXCLUSIVE, so both run while the
 * application keeps writing; the dual-write trigger keeps the new column
 * equal to the old one, so the index and the constraints hold the same rows
 * as the old ones. A foreign key from another table is added against the
 * new column's working unique index, which the switch then attaches to the
 * key constraint. Everything in the switch changes only the catalog.
 *
 * Working objects carry chant's trailer with `migration=<key>` and
 * `role=carry`, so the catalog read leaves them out of plans until the
 * switch, and onFailure drops them (`./steps.ts`). The switch gives each its
 * old comment back.
 *
 * Names: a type change keeps every name. A rename keeps a name the
 * declaration does not give otherwise, except one Postgres made from the
 * old column (`users_email_key` becomes `users_login_key`); a key, foreign
 * key or index the build declares on the new column takes the declared name.
 *
 * Refused, each named with what to do: exclusion constraints and constraint
 * triggers (no `USING INDEX` form), materialized views (made again only by
 * a full scan in the switch), rules, triggers, policies and statistics on the
 * column, a generated column computed from it, an INVALID index on it, a view
 * the build does not declare, a view something other than a view depends on.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { quoteIdent } from "../keywords";
import type { PostgresClient } from "../live/client";
import { tokenizeText, type Token } from "../tokens";
import { identValue } from "../parser";
import { createSteps, pgString, type DeclaredPgObject } from "../apply/statements";
import type { ColumnDef, ForeignKeyDef, KeyDef } from "../entities";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import { canonicalName } from "../plan/normalize";
import { pgName, type MigrationNames } from "./names";

export type CarriedKind = "index" | "key" | "check" | "foreign-key";

/** One index or constraint on the old column, and how it is made on the new one. */
export interface CarriedObject {
  kind: CarriedKind;
  /** Its name now. */
  name: string;
  /** The table it is on, quoted and qualified (the referencing table for a foreign key). */
  table: string;
  /** The same, as `schema.table`, for messages. */
  tableName: string;
  tableOid: string;
  /** The schema an index lives in (its table's). */
  schema: string;
  /** Its name on the new column until the switch. */
  working: string;
  /** Its name after the switch. */
  target: string;
  /**
   * What makes the working object: for an index or a key, the `CREATE INDEX
   * CONCURRENTLY` statement; for a check or a foreign key, the constraint's
   * body (`CHECK (...)`, `FOREIGN KEY ... REFERENCES ...`), added `NOT VALID`.
   */
  definition: string;
  /** A key: `PRIMARY KEY` or `UNIQUE`, and its deferral. */
  primary?: boolean;
  deferral?: string;
  /** A constraint: validated on the server, so validated on the new column before the switch. */
  validated: boolean;
  comment?: string;
  /** A key: the comment of its index. */
  indexComment?: string;
  replicaIdentity?: boolean;
  clustered?: boolean;
}

/** A view on the old column (or on such a view), made again at the switch from its declaration. */
export interface CarriedView {
  /** `schema.name`. */
  name: string;
  /** Quoted and qualified. */
  ident: string;
  materialized: false;
  /** How many views lie between it and the table: dropped deepest first, created shallowest first. */
  depth: number;
  declared: DeclaredPgObject;
  owner: string;
  grants: Array<{ grantee: string; privilege: string; grantable: boolean }>;
}

/** The sequence that belongs to the column: its identity's, or a `serial` column's. A type change moves it to the new column at the switch. */
export interface ColumnSequence {
  kind: "identity" | "serial";
  schema: string;
  name: string;
  /** Quoted and qualified. */
  ident: string;
}

export interface Dependents {
  carried: CarriedObject[];
  views: CarriedView[];
  sequence?: ColumnSequence;
  /** What the Op does not carry, each as a sentence naming the object. */
  refused: string[];
}

/** The working name of a carried object, and the name a rename keeps the old one under. */
export const carriedWorkingName = (name: string): string => pgName(`${name}__chant_new`);
export const carriedOldName = (name: string): string => pgName(`${name}__chant_old`);

/**
 * `sql` with every reference to the column `from` replaced by `to`: an
 * identifier token naming it, not a qualifier (`x.`), a qualified name's
 * last part, a function's name, a cast's type or an access method. Within
 * `[start, end)` token indexes when given.
 */
export function replaceColumn(sql: string, from: string, to: string, range?: (tokens: readonly Token[]) => Array<[number, number]>): string {
  const tokens = tokenizeText(sql, 0);
  const ranges = range ? range(tokens) : [[0, tokens.length] as [number, number]];
  const significant = (i: number, step: number): Token | undefined => {
    for (let j = i + step; j >= 0 && j < tokens.length; j += step) if (tokens[j]!.kind !== "ws" && tokens[j]!.kind !== "comment") return tokens[j];
    return undefined;
  };
  const inRange = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  return tokens
    .map((t, i) => {
      if ((t.kind !== "ident" && t.kind !== "qident") || !inRange(i) || identValue(t) !== from) return t.text;
      const prev = significant(i, -1);
      const next = significant(i, 1);
      if (prev?.text === "." || next?.text === "." || next?.text === "(") return t.text;
      if (prev?.kind === "op" && prev.text === "::") return t.text;
      if (prev?.kind === "ident" && /^using$/i.test(prev.text)) return t.text;
      return quoteIdent(to);
    })
    .join("");
}

/**
 * A foreign key's token ranges: the referencing side (before `REFERENCES`,
 * and an `ON DELETE SET NULL (...)` list after it) and the referenced
 * column list.
 */
function foreignKeyRanges(tokens: readonly Token[]): { local: Array<[number, number]>; referenced: Array<[number, number]> } {
  const at = tokens.findIndex((t) => t.kind === "ident" && /^references$/i.test(t.text));
  if (at < 0) return { local: [[0, tokens.length]], referenced: [] };
  let open = at + 1;
  while (open < tokens.length && !(tokens[open]!.kind === "punct" && tokens[open]!.text === "(")) open++;
  let close = open;
  for (let depth = 0; close < tokens.length; close++) {
    if (tokens[close]!.text === "(") depth++;
    else if (tokens[close]!.text === ")" && --depth === 0) break;
  }
  return { local: [[0, at], [close + 1, tokens.length]], referenced: open < tokens.length ? [[open, close + 1]] : [] };
}

/** A foreign key's body with the column replaced on the side(s) that are the migrated table. */
export function replaceInForeignKey(def: string, from: string, to: string, sides: { local: boolean; referenced: boolean }): string {
  return replaceColumn(def, from, to, (tokens) => {
    const r = foreignKeyRanges(tokens);
    return [...(sides.local ? r.local : []), ...(sides.referenced ? r.referenced : [])];
  });
}

/** A constraint's body without a trailing `NOT VALID`, which the carry adds itself. */
const withoutNotValid = (def: string): string => def.replace(/\s+NOT VALID\s*$/i, "");

/**
 * `CREATE [UNIQUE] INDEX <name> ON ...` as `pg_get_indexdef` prints it, as
 * the `CONCURRENTLY` build of `working` on the new column.
 */
export function carriedIndexStatement(def: string, working: string, from: string, to: string): string {
  const m = /^CREATE (UNIQUE )?INDEX (?:"(?:[^"]|"")+"|\S+) ON (.*)$/s.exec(def);
  if (!m) throw new Error(`unexpected index definition: ${def}`);
  return `CREATE ${m[1] ?? ""}INDEX CONCURRENTLY ${quoteIdent(working)} ON ${replaceColumn(m[2]!, from, to)}`;
}

/**
 * The name Postgres gives an object it names after its columns
 * (`users_email_key`, `orders_user_id_fkey`, `users_email_idx`), when `name`
 * is that name for the old columns: the same name for the new ones. Only a
 * name that fits untruncated; any other name is kept.
 */
export function renamedDefault(name: string, table: string, oldCols: readonly string[], newCols: readonly string[], suffix: string): string | undefined {
  const made = (cols: readonly string[]) => `${table}_${cols.join("_")}_${suffix}`;
  if (name !== made(oldCols)) return undefined;
  const next = made(newCols);
  return Buffer.byteLength(next, "utf8") <= 63 && next !== name ? next : undefined;
}

const sameColumns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

interface DiscoverInput {
  client: PostgresClient;
  names: MigrationNames;
  oid: string;
  attnum: number;
  /** Every object the build declares: views are made again from theirs, and a declared name wins on a rename. */
  objects: readonly DeclaredPgObject[];
  /** The declared table. */
  declared: DeclaredPgObject;
  defaultSchema: string;
  /** The table is partitioned: its indexes cannot be built CONCURRENTLY, nor its keys attached USING INDEX. */
  partitioned?: boolean;
}

interface Row {
  [key: string]: unknown;
}

/** What uses the column the values come from, sorted into what the Op carries over and what it refuses. */
export async function discoverDependents(input: DiscoverInput): Promise<Dependents> {
  const { client, names: n, oid, attnum } = input;
  const from = n.source;
  const to = n.newColumn;
  const deps = await client.query<{ kind: string; objid: string; objsubid: number; what: string; deptype: string }>(
    `SELECT d.deptype::text AS deptype, CASE d.classid WHEN 'pg_catalog.pg_constraint'::pg_catalog.regclass THEN 'constraint' WHEN 'pg_catalog.pg_class'::pg_catalog.regclass THEN 'class'
                           WHEN 'pg_catalog.pg_rewrite'::pg_catalog.regclass THEN 'rewrite' WHEN 'pg_catalog.pg_attrdef'::pg_catalog.regclass THEN 'attrdef' ELSE 'other' END AS kind,
            d.objid::text AS objid, d.objsubid, pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS what
     FROM pg_catalog.pg_depend d
     WHERE d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = $1::oid AND d.refobjsubid = $2 AND d.deptype IN ('n', 'a', 'i')
     UNION
     SELECT 'n', 'constraint', c.oid::text, 0, pg_catalog.pg_describe_object('pg_catalog.pg_constraint'::pg_catalog.regclass, c.oid, 0)
     FROM pg_catalog.pg_constraint c WHERE c.confrelid = $1::oid AND $2 = ANY(c.confkey)`,
    [oid, attnum],
  );
  const refused: string[] = [];
  const carried: CarriedObject[] = [];
  let sequence: ColumnSequence | undefined;
  const byKind = (k: string) => [...new Set(deps.filter((d) => d.kind === k).map((d) => d.objid))];
  const table = n.table;
  const rename = n.change === "rename";
  const tprops = input.declared.props as { primaryKey?: KeyDef; uniques?: KeyDef[]; foreignKeys?: ForeignKeyDef[] };

  // ── constraints ─────────────────────────────────────────────────────
  const constraintIds = byKind("constraint");
  const keyIndexes = new Set<string>();
  if (constraintIds.length > 0) {
    const rows = await client.query<Row>(
      `SELECT c.oid::text AS oid, c.conname AS name, c.contype::text AS type, c.conrelid::text AS rel, c.confrelid::text AS frel, c.conindid::text AS idx,
              pg_catalog.pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated, c.condeferrable AS deferrable, c.condeferred AS deferred,
              pg_catalog.obj_description(c.oid, 'pg_constraint') AS comment, n.nspname AS schema, t.relname AS table_name,
              CASE WHEN c.conindid <> 0 THEN pg_catalog.obj_description(c.conindid, 'pg_class') END AS index_comment,
              CASE WHEN c.conindid <> 0 AND c.contype IN ('p', 'u') THEN pg_catalog.pg_get_indexdef(c.conindid) END AS indexdef,
              COALESCE(i.indisreplident, false) AS replident, COALESCE(i.indisclustered, false) AS clustered,
              (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS first_col,
              ARRAY(SELECT a.attname FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
              t.relkind = 'p' OR EXISTS (SELECT 1 FROM pg_catalog.pg_class f WHERE f.oid = c.confrelid AND f.relkind = 'p') AS frel_partitioned
       FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.conindid
       WHERE c.oid = ANY($1::oid[]) ORDER BY c.conname`,
      [constraintIds],
    );
    for (const r of rows) {
      const name = String(r.name);
      const own = String(r.rel) === oid;
      const where = `${String(r.schema)}.${String(r.table_name)}`;
      const qtable = `${quoteIdent(String(r.schema))}.${quoteIdent(String(r.table_name))}`;
      const type = String(r.type);
      if (type === "n" && own) continue; // the column's own NOT NULL (18)
      const comment = r.comment === null ? undefined : String(r.comment);
      const base = { name, table: qtable, tableName: where, tableOid: String(r.rel), schema: String(r.schema), working: carriedWorkingName(name), validated: r.validated === true, ...(comment !== undefined ? { comment } : {}) };
      const cols = (r.cols as string[] | null) ?? [];
      const newCols = cols.map((c) => (own && c === from ? n.column : c));
      if (input.partitioned && (type === "p" || type === "u" || type === "f")) {
        keyIndexes.add(String(r.idx));
        refused.push(
          `${type === "f" ? "foreign key" : type === "p" ? "primary key" : "unique constraint"} ${name} on ${where}: on a partitioned table ${type === "f" ? "a foreign key cannot be added NOT VALID and validated while writes go on" : "a key cannot be attached from an index built CONCURRENTLY (ADD CONSTRAINT ... USING INDEX is not supported on partitioned tables)"}, so carrying it over would hold ACCESS EXCLUSIVE for a full build; drop it, migrate, then declare it again`,
        );
        continue;
      }
      if (type === "f" && !own && r.frel_partitioned === true) {
        refused.push(`foreign key ${name} on ${where} references a partitioned table, where it cannot be added NOT VALID and validated while writes go on; drop it, migrate, then declare it again`);
        continue;
      }
      if (type === "p" || type === "u") {
        keyIndexes.add(String(r.idx));
        const declaredKey = type === "p" ? (tprops.primaryKey?.name ? tprops.primaryKey : undefined) : tprops.uniques?.find((u) => u.name && sameColumns(u.columns, newCols));
        const target = !rename ? name : (declaredKey?.name ?? (type === "u" ? renamedDefault(name, table, cols, newCols, "key") : undefined) ?? name);
        const deferral = r.deferrable === true ? ` DEFERRABLE${r.deferred === true ? " INITIALLY DEFERRED" : ""}` : "";
        carried.push({
          ...base,
          kind: "key",
          target,
          primary: type === "p",
          ...(deferral ? { deferral } : {}),
          definition: carriedIndexStatement(String(r.indexdef), base.working, from, to),
          ...(r.index_comment !== null && r.index_comment !== undefined ? { indexComment: String(r.index_comment) } : {}),
          ...(r.replident === true ? { replicaIdentity: true } : {}),
          ...(r.clustered === true ? { clustered: true } : {}),
        });
      } else if (type === "c") {
        const first = String(r.first_col ?? "");
        const target = !rename ? name : (renamedDefault(name, table, [first], [first === from ? n.column : first], "check") ?? name);
        carried.push({ ...base, kind: "check", target, definition: replaceColumn(withoutNotValid(String(r.def)), from, to) });
      } else if (type === "f") {
        const referenced = String(r.frel) === oid;
        const def = replaceInForeignKey(withoutNotValid(String(r.def)), from, to, { local: own, referenced });
        let target = name;
        if (rename && own) {
          const declaredFk = tprops.foreignKeys?.find((f) => f.name && sameColumns(f.columns, newCols));
          target = declaredFk?.name ?? renamedDefault(name, table, cols, newCols, "fkey") ?? name;
        }
        carried.push({ ...base, kind: "foreign-key", target, definition: def });
      } else if (type === "x") {
        refused.push(`exclusion constraint ${name} on ${where}: an exclusion constraint cannot be attached from an index built CONCURRENTLY, so adding it again would hold ACCESS EXCLUSIVE for a full build; drop it, migrate, then declare it again`);
      } else if (type === "t") {
        refused.push(`constraint trigger ${name} on ${where}: its function reads the column by name, which the Op cannot rewrite; drop it, migrate, then create it again`);
      } else {
        refused.push(`constraint ${name} on ${where} (type ${type})`);
      }
    }
  }

  // ── indexes, sequences, columns ─────────────────────────────────────
  const classIds = byKind("class");
  if (classIds.length > 0) {
    const rows = await client.query<Row>(
      `SELECT c.oid::text AS oid, c.relname AS name, c.relkind::text AS kind, n.nspname AS schema, pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.relkind IN ('i', 'I') THEN pg_catalog.pg_get_indexdef(c.oid) END AS def,
              i.indisvalid AS valid, i.indisunique AS is_unique, COALESCE(i.indisreplident, false) AS replident, COALESCE(i.indisclustered, false) AS clustered,
              ARRAY(SELECT a.attname FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o) JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
              i.indexprs IS NOT NULL OR i.indpred IS NOT NULL AS has_exprs
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
       WHERE c.oid = ANY($1::oid[]) ORDER BY c.relname`,
      [classIds],
    );
    const declaredIndexes = input.objects.filter((o) => o.type === POSTGRES_ENTITY_TYPES.index);
    for (const r of rows) {
      const name = String(r.name);
      const kind = String(r.kind);
      if (kind === "i" || kind === "I") {
        if (keyIndexes.has(String(r.oid))) continue;
        if (kind === "I") {
          refused.push(`index ${r.schema}.${name} is a partitioned index, which cannot be built CONCURRENTLY; drop it, migrate, then declare it again`);
          continue;
        }
        if (r.valid !== true) {
          refused.push(`index ${r.schema}.${name} is INVALID (a failed CONCURRENTLY build); drop it, or REINDEX it, first`);
          continue;
        }
        const working = carriedWorkingName(name);
        let target = name;
        if (rename) {
          const oldCols = (r.cols as string[] | null) ?? [];
          const cols = oldCols.map((c) => (c === from ? n.column : c));
          const declaredIndex =
            r.has_exprs === true
              ? undefined
              : declaredIndexes.find((d) => {
                  const p = d.props as { tableName?: string; unique?: boolean; elements?: Array<{ column?: string }>; where?: string };
                  const els = p.elements ?? [];
                  return (
                    canonicalName(String(p.tableName ?? ""), input.defaultSchema) === `${n.schema}.${n.table}` &&
                    (p.unique === true) === (r.is_unique === true) &&
                    !p.where &&
                    els.every((e) => e.column !== undefined) &&
                    sameColumns(
                      els.map((e) => e.column!),
                      cols,
                    )
                  );
                });
          target = declaredIndex?.canonical.name ?? (r.has_exprs === true ? undefined : renamedDefault(name, table, oldCols, cols, "idx")) ?? name;
        }
        carried.push({
          kind: "index",
          name,
          table: n.qualifiedTable,
          tableName: `${n.schema}.${n.table}`,
          tableOid: oid,
          schema: String(r.schema),
          working,
          target,
          definition: carriedIndexStatement(String(r.def), working, from, to),
          validated: true,
          ...(r.comment !== null ? { comment: String(r.comment) } : {}),
          ...(r.replident === true ? { replicaIdentity: true } : {}),
          ...(r.clustered === true ? { clustered: true } : {}),
        });
      } else if (kind === "S") {
        const dep = deps.find((d) => d.kind === "class" && d.objid === String(r.oid));
        const seq: ColumnSequence = { kind: dep?.deptype === "i" ? "identity" : "serial", schema: String(r.schema), name, ident: `${quoteIdent(String(r.schema))}.${quoteIdent(name)}` };
        if (rename) {
          refused.push(
            `sequence ${r.schema}.${name} gives the column its values (${seq.kind === "identity" ? "an identity column" : "a serial column's default"}); during a rename a writer that names the new column would be given the old one's next value by the trigger, which it cannot tell from a value the writer chose (see the default on a rename)`,
          );
        } else sequence = seq;
      } else {
        const what = deps.find((d) => d.kind === "class" && d.objid === String(r.oid))?.what ?? `${r.schema}.${name}`;
        refused.push(what);
      }
    }
  }

  // ── generated columns computed from it ──────────────────────────────
  const attrdefIds = byKind("attrdef");
  if (attrdefIds.length > 0) {
    const rows = await client.query<{ name: string; adnum: number }>(
      "SELECT a.attname AS name, d.adnum FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.oid = ANY($1::oid[])",
      [attrdefIds],
    );
    for (const r of rows) {
      if (Number(r.adnum) === attnum) continue; // its own default
      refused.push(`generated column ${n.schema}.${n.table}.${r.name} is computed from it; computing it from the new column would rewrite the table, so drop the generated column, migrate, then declare it again`);
    }
  }

  // ── views, rules ────────────────────────────────────────────────────
  const views: CarriedView[] = [];
  const rewriteIds = byKind("rewrite");
  if (rewriteIds.length > 0) {
    const rows = await client.query<Row>(
      `WITH RECURSIVE v(oid, depth) AS (
         SELECT r.ev_class, 0 FROM pg_catalog.pg_rewrite r WHERE r.oid = ANY($1::oid[]) AND r.ev_class <> $2::oid
         UNION
         SELECT r.ev_class, v.depth + 1 FROM v
         JOIN pg_catalog.pg_depend d ON d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = v.oid AND d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
         JOIN pg_catalog.pg_rewrite r ON r.oid = d.objid AND r.ev_class <> v.oid
       )
       SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, max(v.depth) AS depth,
              pg_catalog.pg_get_userbyid(c.relowner) AS owner,
              ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(x.grantee)) END || E'\\t' || x.privilege_type || E'\\t' || x.is_grantable::text
                    FROM pg_catalog.aclexplode(c.relacl) x WHERE x.grantee <> c.relowner)::text[] AS grants,
              ARRAY(SELECT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_catalog.pg_depend d
                    WHERE d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = c.oid AND d.deptype = 'n'
                      AND d.classid NOT IN ('pg_catalog.pg_rewrite'::pg_catalog.regclass, 'pg_catalog.pg_type'::pg_catalog.regclass))::text[] AS others
       FROM v JOIN pg_catalog.pg_class c ON c.oid = v.oid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       GROUP BY c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relacl ORDER BY 5, 2, 3`,
      [rewriteIds, oid],
    );
    const ownRules = await client.query<{ name: string }>("SELECT r.rulename AS name FROM pg_catalog.pg_rewrite r WHERE r.oid = ANY($1::oid[]) AND r.ev_class = $2::oid", [rewriteIds, oid]);
    for (const r of ownRules) refused.push(`rule ${r.name} on ${n.schema}.${n.table} reads the column; drop it, migrate, then create it again`);
    for (const r of rows) {
      const name = `${String(r.schema)}.${String(r.name)}`;
      if (r.kind === "m") {
        refused.push(`materialized view ${name} reads the column; making it again would scan in the switch's transaction, so drop it, migrate, then declare it again`);
        continue;
      }
      if (r.kind !== "v") {
        refused.push(`${name} (relkind ${String(r.kind)}) reads the column`);
        continue;
      }
      const others = (r.others as string[] | null) ?? [];
      if (others.length > 0) refused.push(`view ${name} is used by ${others.join(", ")}, which dropping and creating the view again would break`);
      const declared = input.objects.find((o) => (o.type === POSTGRES_ENTITY_TYPES.view || o.type === POSTGRES_ENTITY_TYPES.materializedView) && `${o.canonical.schema ?? input.defaultSchema}.${o.canonical.name}` === name);
      if (!declared) {
        refused.push(
          `view ${name} reads ${rename ? `${from}, which the rename takes away` : "the column"}, and the build does not declare it; the switch makes each such view again from its declaration, so declare it (reading ${n.column}) in the build`,
        );
        continue;
      }
      if (declared.type !== POSTGRES_ENTITY_TYPES.view) {
        refused.push(`view ${name} is declared as a ${declared.type}`);
        continue;
      }
      views.push({
        name,
        ident: `${quoteIdent(String(r.schema))}.${quoteIdent(String(r.name))}`,
        materialized: false,
        depth: Number(r.depth),
        declared,
        owner: String(r.owner),
        grants: ((r.grants as string[] | null) ?? []).map((g) => {
          const [grantee, privilege, grantable] = g.split("\t") as [string, string, string];
          return { grantee, privilege, grantable: grantable === "true" };
        }),
      });
    }
  }

  for (const d of deps.filter((x) => x.kind === "other")) refused.push(`${d.what} uses the column; drop it, migrate, then create it again`);

  // A new name already taken by something else stops the switch; say so now.
  const renamed = carried.filter((c) => c.target !== c.name);
  if (renamed.length > 0) {
    const taken = await client.query<{ name: string }>(
      `SELECT x.name FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[]), pg_catalog.unnest($3::oid[])) AS x(name, schema, rel)
       WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = x.schema AND c.relname = x.name)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = x.rel AND k.conname = x.name)`,
      [renamed.map((c) => c.target), renamed.map((c) => c.schema), renamed.map((c) => c.tableOid)],
    );
    for (const t of taken) refused.push(`${t.name}, the name ${renamed.find((c) => c.target === t.name)!.name} takes after the rename, is already used; rename that object first`);
  }

  return { carried, views, refused, ...(sequence ? { sequence } : {}) };
}

// ── statements ──────────────────────────────────────────────────────

/** `ALTER TABLE ... ADD CONSTRAINT <working> <body> NOT VALID`: a check or foreign key on the new column. */
export const addCarriedConstraint = (c: CarriedObject): string => `ALTER TABLE ${c.table} ADD CONSTRAINT ${quoteIdent(c.working)} ${c.definition} NOT VALID`;

const commentOn = (what: string, text: string | undefined) => `COMMENT ON ${what} IS ${text === undefined ? "NULL" : pgString(text)}`;
const indexIdent = (c: CarriedObject, name: string) => `${quoteIdent(c.schema)}.${quoteIdent(name)}`;

/**
 * The switch's statements for the carried objects, around the swap of the
 * columns: `before` drops the views and swaps every index and constraint;
 * `after` creates the views again from their declarations once the column
 * they read has its name.
 *
 * Foreign keys that reference the column go first: the old key constraint
 * cannot be dropped while one depends on its index.
 */
export function carriedSwitchStatements(
  carried: readonly CarriedObject[],
  views: readonly CarriedView[],
  change: "rename" | "type",
  oldComment: (c: CarriedObject) => string,
  marker: OwnershipMarker | undefined,
): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const v of [...views].sort((a, b) => b.depth - a.depth)) before.push(`DROP VIEW ${v.ident}`);
  const order: CarriedKind[] = ["foreign-key", "check", "key", "index"];
  const sorted = [...carried].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const c of sorted) {
    const keepOld = change === "rename" && (c.kind === "index" || (c.kind === "key" && !c.primary));
    if (c.kind === "check" || c.kind === "foreign-key") {
      before.push(`ALTER TABLE ${c.table} DROP CONSTRAINT ${quoteIdent(c.name)}`);
      before.push(`ALTER TABLE ${c.table} RENAME CONSTRAINT ${quoteIdent(c.working)} TO ${quoteIdent(c.target)}`);
      before.push(commentOn(`CONSTRAINT ${quoteIdent(c.target)} ON ${c.table}`, c.comment));
    } else if (c.kind === "key") {
      if (keepOld) {
        before.push(`ALTER TABLE ${c.table} RENAME CONSTRAINT ${quoteIdent(c.name)} TO ${quoteIdent(carriedOldName(c.name))}`);
        before.push(commentOn(`CONSTRAINT ${quoteIdent(carriedOldName(c.name))} ON ${c.table}`, oldComment(c)));
      } else {
        before.push(`ALTER TABLE ${c.table} DROP CONSTRAINT ${quoteIdent(c.name)}`);
      }
      before.push(`ALTER TABLE ${c.table} ADD CONSTRAINT ${quoteIdent(c.target)} ${c.primary ? "PRIMARY KEY" : "UNIQUE"} USING INDEX ${quoteIdent(c.working)}${c.deferral ?? ""}`);
      before.push(commentOn(`CONSTRAINT ${quoteIdent(c.target)} ON ${c.table}`, c.comment));
      before.push(commentOn(`INDEX ${indexIdent(c, c.target)}`, c.indexComment));
    } else {
      if (keepOld) {
        before.push(`ALTER INDEX ${indexIdent(c, c.name)} RENAME TO ${quoteIdent(carriedOldName(c.name))}`);
        before.push(commentOn(`INDEX ${indexIdent(c, carriedOldName(c.name))}`, oldComment(c)));
      } else {
        before.push(`DROP INDEX ${indexIdent(c, c.name)}`);
      }
      before.push(`ALTER INDEX ${indexIdent(c, c.working)} RENAME TO ${quoteIdent(c.target)}`);
      before.push(commentOn(`INDEX ${indexIdent(c, c.target)}`, c.comment));
    }
    if (c.replicaIdentity) before.push(`ALTER TABLE ${c.table} REPLICA IDENTITY USING INDEX ${quoteIdent(c.target)}`);
    if (c.clustered) before.push(`ALTER TABLE ${c.table} CLUSTER ON ${quoteIdent(c.target)}`);
  }
  for (const v of [...views].sort((a, b) => a.depth - b.depth)) {
    for (const s of createSteps(v.declared, marker)) after.push(s.sql);
    after.push(`ALTER VIEW ${v.ident} OWNER TO ${quoteIdent(v.owner)}`);
    for (const g of v.grants) after.push(`GRANT ${g.privilege} ON TABLE ${v.ident} TO ${g.grantee}${g.grantable ? " WITH GRANT OPTION" : ""}`);
  }
  return { before, after };
}

/** What the gate binds about the carried objects: each one's kind, names and definition, and each view. */
export function carriedSubject(d: Pick<Dependents, "carried" | "views" | "sequence">): unknown {
  return {
    ...(d.sequence ? { sequence: { kind: d.sequence.kind, name: `${d.sequence.schema}.${d.sequence.name}` } } : {}),
    carried: d.carried.map((c) => ({ kind: c.kind, table: c.tableName, name: c.name, target: c.target, definition: c.definition, ...(c.primary !== undefined ? { primary: c.primary } : {}) })),
    views: d.views.map((v) => ({ name: v.name, ddl: v.declared.ddl })),
  };
}

/** Whether a declared column is NOT NULL once it is switched: declared so, an identity column, or part of a carried primary key. */
export const requiresNotNull = (column: ColumnDef, carried: readonly CarriedObject[]): boolean =>
  column.notNull === true || column.generated?.kind === "identity" || SERIAL_TYPES[column.type ?? ""] !== undefined || carried.some((c) => c.kind === "key" && c.primary === true);

/** The integer type of each `serial` spelling: what the column holds, and the sequence's type. */
export const SERIAL_TYPES: Readonly<Record<string, string>> = {
  smallserial: "smallint",
  serial2: "smallint",
  serial: "integer",
  serial4: "integer",
  bigserial: "bigint",
  serial8: "bigint",
};

/** A declared column's type as the server holds it: a `serial` spelling is its integer type. */
export const storedType = (type: string | undefined): string | undefined => (type === undefined ? undefined : (SERIAL_TYPES[type.replace(/^(public|pg_catalog)\./, "")] ?? type));

/** How far a carried object's working copy has got on the server. */
export interface CarriedState {
  /** The working object is there. */
  present: boolean;
  /** An index: valid (its CONCURRENTLY build finished). A constraint: validated. */
  ready: boolean;
  /** It carries this migration's trailer; an index built and killed before its comment is adopted when its definition is the one expected. */
  marked: boolean;
}

/**
 * The working copies of the carried objects on the server, by working name.
 * One under a working name that is somebody else's is refused, as for the
 * other working objects (`./observe.ts`).
 */
export async function carriedStates(
  client: PostgresClient,
  carried: readonly CarriedObject[],
  ours: (comment: string | undefined) => "ours" | "theirs" | "none",
  refuse: (what: string) => never,
): Promise<Map<string, CarriedState>> {
  const out = new Map<string, CarriedState>();
  const indexes = carried.filter((c) => c.kind === "index" || c.kind === "key");
  const constraints = carried.filter((c) => c.kind === "check" || c.kind === "foreign-key");
  if (indexes.length > 0) {
    const rows = await client.query<{ name: string; valid: boolean; comment: string | null; def: string }>(
      `SELECT c.relname AS name, i.indisvalid AS valid, pg_catalog.obj_description(c.oid, 'pg_class') AS comment, pg_catalog.pg_get_indexdef(c.oid) AS def
       FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[])) AS x(name, schema)
       JOIN pg_catalog.pg_namespace s ON s.nspname = x.schema JOIN pg_catalog.pg_class c ON c.relnamespace = s.oid AND c.relname = x.name
       LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid`,
      [indexes.map((c) => c.working), indexes.map((c) => c.schema)],
    );
    for (const r of rows) {
      const c = indexes.find((x) => x.working === r.name)!;
      const owner = ours(r.comment ?? undefined);
      const expected = c.definition.replace(/ INDEX CONCURRENTLY /, " INDEX ");
      if (owner === "theirs" || (owner === "none" && r.def !== expected)) refuse(`index ${c.schema}.${c.working}`);
      out.set(c.working, { present: true, ready: r.valid === true, marked: owner === "ours" });
    }
  }
  if (constraints.length > 0) {
    const rows = await client.query<{ name: string; rel: string; validated: boolean; comment: string | null }>(
      `SELECT k.conname AS name, k.conrelid::text AS rel, k.convalidated AS validated, pg_catalog.obj_description(k.oid, 'pg_constraint') AS comment
       FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::oid[])) AS x(name, rel) JOIN pg_catalog.pg_constraint k ON k.conrelid = x.rel AND k.conname = x.name`,
      [constraints.map((c) => c.working), constraints.map((c) => c.tableOid)],
    );
    for (const r of rows) {
      const c = constraints.find((x) => x.working === r.name && x.tableOid === r.rel)!;
      if (ours(r.comment ?? undefined) !== "ours") refuse(`constraint ${c.working} on ${c.tableName}`);
      out.set(c.working, { present: true, ready: r.validated === true || !c.validated, marked: true });
    }
  }
  return out;
}

/** The carried objects whose working copy is not there, not marked, or not yet valid. */
export const carriedNotReady = (carried: readonly CarriedObject[], states: ReadonlyMap<string, CarriedState>): CarriedObject[] =>
  carried.filter((c) => {
    const s = states.get(c.working);
    return !s || !s.ready || !s.marked;
  });
