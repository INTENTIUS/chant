/**
 * How a plan hands a rebuild to the rebuild migration Op (#3198).
 *
 * `chant sql plan`, `chant sql diff` and the applier refuse a rebuild in
 * place. What they hand on is the Op to run instead, one per table: a
 * `ClickHouseRebuildOp` declaration ready to put in an `*.op.ts` file, with
 * the table's `database.name` filled in and a dual-write mode suggested from
 * the declared columns (materialized-view mode on the first time column,
 * otherwise app mode). The Op's own Plan phase then classifies the same
 * change again against the server, so what it runs is what the plan refused,
 * read fresh.
 *
 * Nothing is written for the user: the Op is a declaration, reviewed in the
 * pull request like the schema change it carries out. The hand-off's shape is
 * the shared core's (`../../core/handoff.ts`); the Op and the dual-write
 * suggestion are ClickHouse's.
 */

import type { CanonicalObject } from "./normalize";
import type { SchemaDiff } from "./diff";
import { migrationOpName, renderMigrationOps, type MigrationOpSuggestion } from "../../core/handoff";
import { collapsesRows } from "../rebuild/engines";

export interface RebuildOpSuggestion extends MigrationOpSuggestion {
  /** `database.name`, the Op's `table`. */
  table: string;
  dualWrite: { mode: "materialized-view"; cutoverColumn: string } | { mode: "app" };
  /** What to know before running it: set for an engine that collapses rows by sorting key (#3674, #3727). */
  note?: string;
}

const TIME_TYPE = /^(?:Nullable\s*\(\s*)?(?:Date|Date32|DateTime|DateTime64)\b/;

/**
 * One suggestion per object the diff refuses as a rebuild. `declared` maps
 * the diff's object keys to the declared definitions.
 */
export function rebuildOpSuggestions(diff: SchemaDiff, declared: ReadonlyMap<string, CanonicalObject>, env: string): RebuildOpSuggestion[] {
  const out: RebuildOpSuggestion[] = [];
  for (const key of [...new Set(diff.rebuilds.map((c) => c.object))]) {
    const c = declared.get(key);
    if (!c || c.kind !== "table") continue;
    const table = `${c.database ?? "default"}.${c.name}`;
    const time = c.columns.find((col) => !col.nullable && TIME_TYPE.test(col.type) && (!col.defaultKind || col.defaultKind === "DEFAULT"));
    const dualWrite: RebuildOpSuggestion["dualWrite"] = time ? { mode: "materialized-view", cutoverColumn: time.name } : { mode: "app" };
    const name = migrationOpName("rebuild", table);
    const dw = dualWrite.mode === "app" ? `{ mode: "app" }` : `{ mode: "materialized-view", cutoverColumn: ${JSON.stringify(dualWrite.cutoverColumn)} }`;
    const note = collapsesRows(c.engineName)
      ? `${table} is a ${c.engineName}: when the old table's engine collapses rows too, the Verify phase reads both tables under FINAL, so rows the old table has not merged yet compare as merged. ` +
        `A new sorting key that collapses rows differently from the old one still fails it; OPTIMIZE TABLE ${table} FINAL before the run avoids that. ` +
        `From an engine that keeps every row (a plain MergeTree), it groups both tables by the new sorting key instead and compares what a ${c.engineName} keeps per key (its sums, its highest version, the sum of its signs).`
      : undefined;
    out.push({
      table,
      name,
      env,
      dualWrite,
      ...(note ? { note } : {}),
      declaration: `export const { op } = ClickHouseRebuildOp({ name: ${JSON.stringify(name)}, env: ${JSON.stringify(env)}, table: ${JSON.stringify(table)}, dualWrite: ${dw} });`,
    });
  }
  return out;
}

/** The suggestions as text, for the report. */
export function renderRebuildOps(ops: readonly RebuildOpSuggestion[]): string[] {
  const notes = ops.flatMap((o) => (o.note ? [`  Note: ${o.note}`] : []));
  return [...renderMigrationOps(ops, { what: "the rebuild migration Op", exportName: "ClickHouseRebuildOp", importPath: "@intentius/chant-lexicon-sql/clickhouse" }), ...notes];
}
