/**
 * OTEL129: A clickhouse exporter writes a table the sql build in the same root does not declare
 *
 * When the build root also declares ClickHouse tables with the sql lexicon, every table a `clickhouse` exporter writes (for the signals whose pipelines use it) must be one of them, in the database the exporter writes to, with every column the exporter's insert statement names. A renamed or dropped table fails here instead of at the exporter's first insert. When `create_schema` is true (the exporter's default) for tables the build declares, it warns: the exporter would run its own `CREATE TABLE IF NOT EXISTS` beside the sql lexicon's plan. A build root with no sql ClickHouse tables is not checked. Sees one build root at a time (#1939); across workspace members the otel lexicon's workspace links check the same tables (#3931).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { clickhouseExportersOf } from "../../clickhouse-tables";
import { collectorConfigs } from "./otel-helpers";

/** The sql lexicon's ClickHouse table entity type, matched by name so otel needs no dependency on the sql lexicon. */
const CLICKHOUSE_TABLE = "ClickHouse::Table";

interface DeclaredTable {
  columns: Set<string>;
}

/** Every ClickHouse table the build declares, by `database.name`. */
export function declaredClickHouseTables(entities: Iterable<Declarable>): Map<string, DeclaredTable> {
  const out = new Map<string, DeclaredTable>();
  for (const e of entities) {
    if (e.entityType !== CLICKHOUSE_TABLE) continue;
    const props = (e as unknown as { props?: { name?: unknown; database?: unknown; columns?: unknown } }).props;
    if (typeof props?.name !== "string") continue;
    const database = typeof props.database === "string" && props.database !== "" ? props.database : "default";
    const columns = new Set<string>();
    for (const c of Array.isArray(props.columns) ? props.columns : []) {
      const name = (c as { name?: unknown })?.name;
      if (typeof name === "string") columns.add(name);
    }
    out.set(`${database}.${props.name}`, { columns });
  }
  return out;
}

/** A column the insert names is declared as itself, or as the flattened fields of a Nested column (`Events.Timestamp`). */
function hasColumn(declared: Set<string>, column: string): boolean {
  if (declared.has(column)) return true;
  for (const c of declared) if (c.startsWith(`${column}.`)) return true;
  return false;
}

export const otel129: PostSynthCheck = {
  id: "OTEL129",
  description: "A clickhouse exporter writes a table the sql build in the same root does not declare",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const declared = declaredClickHouseTables(ctx.entities?.values() ?? []);
    if (declared.size === 0) return [];
    const known = [...declared.keys()].sort();
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const { config } of collectorConfigs(ctx)) {
      for (const exp of clickhouseExportersOf(config)) {
        const createsDeclared: string[] = [];
        for (const t of exp.tables) {
          const qualified = `${exp.database}.${t.name}`;
          const table = declared.get(qualified);
          if (!table) {
            diagnostics.push({
              checkId: "OTEL129",
              severity: "error",
              message:
                `exporter ${exp.id} writes ${t.signal} to ${qualified} (${t.key}), which the sql build does not declare. ` +
                `Declare it (OtelTables from @intentius/chant-lexicon-sql/clickhouse declares the exporter's tables) or point ${t.key} at a declared table. ` +
                `Declared ClickHouse tables: ${known.join(", ")}`,
              entity: exp.id,
              lexicon: "otel",
            });
            continue;
          }
          const missing = t.columns.filter((c) => !hasColumn(table.columns, c));
          if (missing.length > 0) {
            diagnostics.push({
              checkId: "OTEL129",
              severity: "error",
              message: `exporter ${exp.id} inserts ${t.signal} into ${qualified} with column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, which the declared table does not have; the insert would fail`,
              entity: exp.id,
              lexicon: "otel",
            });
          }
          createsDeclared.push(qualified);
        }
        if (exp.createSchema && createsDeclared.length > 0) {
          diagnostics.push({
            checkId: "OTEL129",
            severity: "warning",
            message:
              `exporter ${exp.id} has create_schema true (the default), so at start it runs CREATE TABLE IF NOT EXISTS for ${createsDeclared.join(", ")}, which the sql build declares. ` +
              `Set create_schema: false so the sql lexicon alone manages them`,
            entity: exp.id,
            lexicon: "otel",
          });
        }
      }
    }
    return diagnostics;
  },
};
