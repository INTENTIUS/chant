/**
 * How a Postgres plan hands an expand-and-contract change to the migration
 * Op (#3281), as the ClickHouse plan hands a rebuild to its Op (#3250).
 *
 * `chant sql plan`, `chant sql diff`, the `classify-change` MCP tool and the
 * applier refuse an expand-and-contract change in place. For a column
 * rename (SQLPG205) and a type change across kinds (SQLPG208) what they hand
 * on is a `PostgresMigrationOp` declaration per column, ready to put in an
 * `*.op.ts` file, reviewed in the pull request like the schema change it
 * carries out. The Op's own Plan phase classifies the change again against
 * the server. The other expand-and-contract rules (a NOT NULL column with no
 * default, partitioning, an object rename, a view's columns, enum labels, a
 * domain's type, an object's kind) have no Op yet, and get none.
 *
 * Nothing is written for the user. The hand-off's shape is the shared
 * core's (`../../core/handoff.ts`).
 */

import { migrationOpName, renderMigrationOps, type MigrationOpSuggestion } from "../../core/handoff";
import type { PgChange } from "../plan/diff";
import type { PgDiffObject } from "../plan/schema";

export interface PostgresMigrationOpSuggestion extends MigrationOpSuggestion {
  /** `schema.table`, the Op's `table`. */
  table: string;
  /** The declared column, the Op's `column`. */
  column: string;
  /** The rule the Op makes the change for. */
  rule: "SQLPG205" | "SQLPG208";
}

/** The rules a refused change is handed to the Op for. */
export const HANDED_OFF = new Set(["SQLPG205", "SQLPG208"]);

const COLUMN = /^columns\.([^.]+)(?:\.type)?$/;

/** The table and column a refused change is about, when the Op makes it. */
export function migrationTarget(c: PgChange, declared: Pick<PgDiffObject, "kind" | "schema" | "name"> | undefined, defaultSchema = "public"): { table: string; column: string } | undefined {
  if (!HANDED_OFF.has(c.rule) || !declared || declared.kind !== "table") return undefined;
  const m = COLUMN.exec(c.field);
  if (!m || (c.rule === "SQLPG208" && !c.field.endsWith(".type")) || (c.rule === "SQLPG205" && c.field.endsWith(".type"))) return undefined;
  return { table: `${declared.schema ?? defaultSchema}.${declared.name}`, column: m[1]! };
}

/** The Op's declaration for one column. */
export function migrationDeclaration(name: string, env: string, table: string, column: string): string {
  return `export const { op } = PostgresMigrationOp({ name: ${JSON.stringify(name)}, env: ${JSON.stringify(env)}, table: ${JSON.stringify(table)}, column: ${JSON.stringify(column)} });`;
}

/**
 * One suggestion per column the diff refuses for a rename or a type change
 * across kinds. `declared` maps the diff's object keys to the declared
 * definitions.
 */
export function migrationOpSuggestions(refused: readonly PgChange[], declared: ReadonlyMap<string, PgDiffObject>, env: string, defaultSchema = "public"): PostgresMigrationOpSuggestion[] {
  const out: PostgresMigrationOpSuggestion[] = [];
  const seen = new Set<string>();
  for (const c of refused) {
    const t = migrationTarget(c, declared.get(c.object), defaultSchema);
    if (!t) continue;
    const id = `${t.table}.${t.column}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = migrationOpName("migrate", id);
    out.push({ table: t.table, column: t.column, rule: c.rule as "SQLPG205" | "SQLPG208", name, env, declaration: migrationDeclaration(name, env, t.table, t.column) });
  }
  return out;
}

/** The suggestions as text, for the report. */
export function renderMigrationOpSuggestions(ops: readonly PostgresMigrationOpSuggestion[]): string[] {
  return renderMigrationOps(ops, { what: "the expand-and-contract migration Op", exportName: "PostgresMigrationOp", importPath: "@intentius/chant-lexicon-sql/postgres" });
}
