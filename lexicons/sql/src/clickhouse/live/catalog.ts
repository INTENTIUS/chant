/**
 * Reading a live server's schema: the databases and the tables, views,
 * materialized views and dictionaries in them, from `system.databases`,
 * `system.tables` and `SHOW CREATE`, and the SQL user-defined functions,
 * from `system.functions`.
 */

import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "./bind";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "../entities";
import { isChantWorkingObject, stripMarkerFromStatement } from "../ownership";

/** The server's own databases, never part of a declared schema. */
export const SYSTEM_DATABASES = new Set(["system", "information_schema", "INFORMATION_SCHEMA"]);

export interface LiveObject {
  type: ClickHouseEntityType;
  database?: string;
  name: string;
  /** The engine `system.tables` / `system.databases` report: `MergeTree`, `View`, `MaterializedView`, `Atomic`, `Dictionary`. */
  engine: string;
  uuid?: string;
  /** The object's comment as the server holds it, chant's ownership trailer included (`../ownership.ts`). */
  comment?: string;
  /** `SHOW CREATE` as the server prints it, less chant's ownership trailer, so it reads as the declaration. */
  statement: string;
}

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const ident = (s: string) => `\`${s.replace(/`/g, "``")}\``;

/** The entity type a `system.tables` engine stands for. */
export function entityTypeOfEngine(engine: string): ClickHouseEntityType {
  if (engine === "View") return CLICKHOUSE_ENTITY_TYPES.view;
  if (engine === "MaterializedView") return CLICKHOUSE_ENTITY_TYPES.materializedView;
  return CLICKHOUSE_ENTITY_TYPES.table;
}

/**
 * Every object in the target's databases, sorted by database then name.
 * A materialized view's inner table (`.inner_id.<uuid>`, `.inner.<name>`)
 * belongs to its view and is left out, as are temporary tables. A
 * dictionary is read (#3682) from `system.tables`, where a reader granted
 * `SELECT` on the database sees it without a grant on `system.dictionaries`;
 * a table with the `Dictionary` engine is a table.
 *
 * So are chant's own working objects (`../ownership.ts`
 * `isChantWorkingObject`): a rebuild migration's new, dual-write and retained
 * tables, and the effect receipts database. None of them is a declaration, so
 * a plan, an import or a prune that saw them would propose dropping, importing
 * or pruning the very objects a rebuild in progress depends on.
 */
export async function readLiveSchema(target: ClickHouseTarget, opts: { withStatements?: boolean } = {}): Promise<LiveObject[]> {
  const q = <T>(sql: string) => clickhouseQuery<T>(target.endpoint, sql);
  const scope = target.databases
    ? `IN (${target.databases.map(quote).join(", ")})`
    : `NOT IN (${[...SYSTEM_DATABASES].map(quote).join(", ")})`;

  const databases = await q<{ name: string; engine: string; uuid: string; comment: string }>(
    `SELECT name, engine, toString(uuid) AS uuid, comment FROM system.databases WHERE name ${scope} ORDER BY name`,
  );
  const tables = await q<{ database: string; name: string; engine: string; uuid: string; comment: string; dictionary: number }>(
    `SELECT database, name, engine, toString(uuid) AS uuid, comment, startsWith(create_table_query, 'CREATE DICTIONARY') AS dictionary FROM system.tables ` +
      `WHERE database ${scope} AND NOT is_temporary AND name NOT LIKE '.inner%' ` +
      `ORDER BY database, name`,
  );

  const working = new Set(databases.filter((d) => isChantWorkingObject(d.comment)).map((d) => d.name));
  const out: LiveObject[] = [];
  const statement = async (kind: "DATABASE" | "TABLE", what: string) =>
    opts.withStatements === false
      ? ""
      : stripMarkerFromStatement((await q<{ statement: string }>(`SHOW CREATE ${kind} ${what}`))[0]?.statement ?? "");

  for (const d of databases) {
    if (working.has(d.name)) continue;
    out.push({
      type: CLICKHOUSE_ENTITY_TYPES.database,
      name: d.name,
      engine: d.engine,
      ...(d.uuid && !/^0{8}-/.test(d.uuid) ? { uuid: d.uuid } : {}),
      ...(d.comment ? { comment: d.comment } : {}),
      statement: await statement("DATABASE", ident(d.name)),
    });
  }
  for (const t of tables) {
    if (working.has(t.database) || isChantWorkingObject(t.comment)) continue;
    out.push({
      type: Number(t.dictionary) === 1 ? CLICKHOUSE_ENTITY_TYPES.dictionary : entityTypeOfEngine(t.engine),
      database: t.database,
      name: t.name,
      engine: t.engine,
      ...(t.uuid && !/^0{8}-/.test(t.uuid) ? { uuid: t.uuid } : {}),
      ...(t.comment ? { comment: t.comment } : {}),
      statement: await statement("TABLE", `${ident(t.database)}.${ident(t.name)}`),
    });
  }
  // SQL user-defined functions belong to no database: every one is read, and a caller keeps those it declares.
  const functions = await q<{ name: string; statement: string }>(
    `SELECT name, create_query AS statement FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name`,
  );
  for (const f of functions) {
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.function, name: f.name, engine: "", statement: opts.withStatements === false ? "" : f.statement });
  }
  return out;
}

