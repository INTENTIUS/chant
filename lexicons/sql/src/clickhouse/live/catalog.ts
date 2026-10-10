/**
 * Reading a live server's schema: the databases and the tables, views and
 * materialized views in them, from `system.databases`, `system.tables` and
 * `SHOW CREATE`.
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
  /** The engine `system.tables` / `system.databases` report: `MergeTree`, `View`, `MaterializedView`, `Atomic`. */
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
 * belongs to its view and is left out, as are temporary tables and
 * dictionaries, which `readUnreadableObjects` names instead (#3653). A table
 * with the `Dictionary` engine is a table and is read.
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
  const tables = await q<{ database: string; name: string; engine: string; uuid: string; comment: string }>(
    `SELECT database, name, engine, toString(uuid) AS uuid, comment FROM system.tables ` +
      `WHERE database ${scope} AND NOT is_temporary AND name NOT LIKE '.inner%' ` +
      `AND NOT startsWith(create_table_query, 'CREATE DICTIONARY') ` +
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
      type: entityTypeOfEngine(t.engine),
      database: t.database,
      name: t.name,
      engine: t.engine,
      ...(t.uuid && !/^0{8}-/.test(t.uuid) ? { uuid: t.uuid } : {}),
      ...(t.comment ? { comment: t.comment } : {}),
      statement: await statement("TABLE", `${ident(t.database)}.${ident(t.name)}`),
    });
  }
  return out;
}

/** An object in the target's databases that chant cannot read yet. */
export interface UnreadableObject {
  /** The entity type it would be: `ClickHouse::Dictionary`. */
  type: string;
  database: string;
  name: string;
  /** Why it is not read, for the plan's refusal. */
  reason: string;
}

/**
 * The objects in the target's databases that chant does not read (#3653):
 * the dictionaries. A plan that left them out would neither list them nor
 * say it could not read them, so `chant sql plan` names each one and fails,
 * and `chant lifecycle diff --live` reports each one as unobserved. Limited
 * to `databases` when given; chant's own working databases are left out.
 */
export async function readUnreadableObjects(target: ClickHouseTarget, databases?: ReadonlySet<string>): Promise<UnreadableObject[]> {
  const q = <T>(sql: string) => clickhouseQuery<T>(target.endpoint, sql);
  const scope = target.databases
    ? `IN (${target.databases.map(quote).join(", ")})`
    : `NOT IN (${[...SYSTEM_DATABASES].map(quote).join(", ")})`;
  const working = new Set(
    (await q<{ name: string; comment: string }>(`SELECT name, comment FROM system.databases WHERE name ${scope}`)).filter((d) => isChantWorkingObject(d.comment)).map((d) => d.name),
  );
  // `system.tables`, not `system.dictionaries`: a reader granted SELECT on the database sees it without a grant on the system table.
  const dictionaries = await q<{ database: string; name: string }>(
    `SELECT database, name FROM system.tables WHERE database ${scope} AND startsWith(create_table_query, 'CREATE DICTIONARY') ORDER BY database, name`,
  );
  return dictionaries
    .filter((d) => !working.has(d.database) && (!databases || databases.has(d.database)))
    .map((d) => ({ type: "ClickHouse::Dictionary", database: d.database, name: d.name, reason: "a dictionary, which chant does not read or declare yet" }));
}
