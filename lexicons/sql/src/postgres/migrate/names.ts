/**
 * The names an expand-and-contract migration of one column uses (#3281), and
 * the trailer that marks its working objects.
 *
 * A migration is keyed by `<schema>.<table>.<column>`, the column as the
 * build declares it. Its working objects are:
 *
 * - the new column: the declared name for a rename (`login`), or
 *   `<column>__chant_new` for a type change, until the switch;
 * - the old column after the switch: the old name for a rename (`email`,
 *   still written by the dual-write trigger), or `<column>__chant_old` for a
 *   type change (no longer written);
 * - the dual-write trigger `<column>__chant_sync` on the table and its
 *   function `<table>__<column>__chant_sync` in the table's schema;
 * - the check `<new>__chant_nn` that proves NOT NULL before it is set.
 *
 * Each carries chant's ownership trailer (`../../core/ownership.ts`) with
 * `migration=<key>` and its role in its comment. The catalog read
 * (`../live/catalog.ts`) leaves out a column or a constraint whose comment
 * carries the `migration` key, so a plan, an import and a prune see the table
 * as it was before the migration until the switch, and as declared after it.
 */

import { createHash } from "node:crypto";
import { quoteIdent } from "../keywords";

/** The trailer key on a migration's working objects. */
export const MIGRATION_TRAILER_KEY = "migration";

/** The longest identifier Postgres keeps (NAMEDATALEN - 1 bytes). */
const MAX_IDENT = 63;

/** A name Postgres keeps whole: `base`, or its first bytes and a short hash of all of it when it is longer than 63 bytes. */
export function pgName(base: string): string {
  if (Buffer.byteLength(base, "utf8") <= MAX_IDENT) return base;
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
  let head = base;
  while (Buffer.byteLength(`${head}_${hash}`, "utf8") > MAX_IDENT) head = head.slice(0, -1);
  return `${head}_${hash}`;
}

/** What the migration changes about the column. */
export type MigrationChange = "rename" | "type";

export interface MigrationNames {
  /** `<schema>.<table>.<column>`: the migration's identity. */
  key: string;
  schema: string;
  table: string;
  /** The column as declared. */
  column: string;
  change: MigrationChange;
  /** The column the values come from: the old name for a rename, the column itself for a type change. */
  source: string;
  /** The column being filled until the switch. */
  newColumn: string;
  /** The old column's name after the switch. */
  oldColumn: string;
  trigger: string;
  /** The trigger function's name, unqualified. */
  fn: string;
  /** The check that proves the new column NOT NULL before SET NOT NULL. */
  check: string;
  /** Quoted, qualified: the table and the function. */
  qualifiedTable: string;
  qualifiedFn: string;
}

export function migrationNames(schema: string, table: string, column: string, change: MigrationChange, source: string): MigrationNames {
  const newColumn = change === "rename" ? column : pgName(`${column}__chant_new`);
  const fn = pgName(`${table}__${column}__chant_sync`);
  return {
    key: `${schema}.${table}.${column}`,
    schema,
    table,
    column,
    change,
    source,
    newColumn,
    oldColumn: change === "rename" ? source : pgName(`${column}__chant_old`),
    trigger: pgName(`${column}__chant_sync`),
    fn,
    check: pgName(`${newColumn}__chant_nn`),
    qualifiedTable: pgQualified(schema, table),
    qualifiedFn: pgQualified(schema, fn),
  };
}

/** `schema.name`, each part quoted where Postgres needs it. */
const pgQualified = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

/** A quoted column name. */
export const col = (name: string): string => quoteIdent(name);
