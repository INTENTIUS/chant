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
import { foreignTool } from "../../core/foreign-tables";

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
  /** A row policy's table. */
  table?: string;
  /** The tool that keeps it, for a migration runner's history table (`../../core/foreign-tables.ts`): never chant's to import, change or drop. */
  foreign?: string;
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
 * A table another tool keeps its migration history in (`schema_migrations`,
 * `goose_db_version`, `../../core/foreign-tables.ts`) is read and marked with
 * the tool, as the Postgres reader marks it (#3676): import leaves it out
 * with a warning, and a plan names it in a hint instead of dropping it.
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
    const type = Number(t.dictionary) === 1 ? CLICKHOUSE_ENTITY_TYPES.dictionary : entityTypeOfEngine(t.engine);
    const foreign = type === CLICKHOUSE_ENTITY_TYPES.table ? foreignTool(t.name) : undefined;
    out.push({
      type,
      database: t.database,
      name: t.name,
      engine: t.engine,
      ...(t.uuid && !/^0{8}-/.test(t.uuid) ? { uuid: t.uuid } : {}),
      ...(t.comment ? { comment: t.comment } : {}),
      ...(foreign ? { foreign } : {}),
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


/** The access objects a build declares, by kind and name: what `readLiveAccess` reads. */
export interface DeclaredAccess {
  kind: string;
  name: string;
  database?: string;
  table?: string;
}

/**
 * The users, roles, row policies and grantees' grants the build declares,
 * as the server holds them (#3682): `SHOW CREATE USER`, `SHOW CREATE ROLE`,
 * `SHOW CREATE ROW POLICY`, and for a grantee every line of
 * `SHOW GRANTS FOR`, one per line. Nothing else is read, so a project that
 * declares none needs no access to `system.users` and the like, and an
 * object made by hand is never seen. One that does not exist is left out.
 */
export async function readLiveAccess(target: ClickHouseTarget, declared: readonly DeclaredAccess[], opts: { withStatements?: boolean } = {}): Promise<LiveObject[]> {
  if (declared.length === 0) return [];
  const q = <T>(sql: string) => clickhouseQuery<T>(target.endpoint, sql);
  const first = async (sql: string) => (opts.withStatements === false ? "" : Object.values((await q<Record<string, string>>(sql))[0] ?? {})[0] ?? "");
  const all = async (sql: string) => (await q<Record<string, string>>(sql)).map((r) => Object.values(r)[0] ?? "");
  const names = (kind: string) => [...new Set(declared.filter((d) => d.kind === kind).map((d) => d.name))];
  const users = names("user");
  const roles = names("role");
  const grantees = names("grants");
  const principals = [...new Set([...users, ...roles, ...grantees])];
  const list = (xs: string[]) => xs.map(quote).join(", ");
  const existingUsers = new Set(principals.length ? (await q<{ name: string }>(`SELECT name FROM system.users WHERE name IN (${list(principals)})`)).map((r) => r.name) : []);
  const existingRoles = new Set(principals.length ? (await q<{ name: string }>(`SELECT name FROM system.roles WHERE name IN (${list(principals)})`)).map((r) => r.name) : []);
  const out: LiveObject[] = [];
  for (const name of users.filter((u) => existingUsers.has(u))) {
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.user, name, engine: "", statement: await first(`SHOW CREATE USER ${ident(name)}`) });
  }
  for (const name of roles.filter((r) => existingRoles.has(r))) {
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.role, name, engine: "", statement: await first(`SHOW CREATE ROLE ${ident(name)}`) });
  }
  const policies = declared.filter((d) => d.kind === "rowPolicy");
  if (policies.length > 0) {
    const live = await q<{ name: string; database: string; table: string }>(
      `SELECT short_name AS name, database, table FROM system.row_policies WHERE short_name IN (${list(policies.map((p) => p.name))})`,
    );
    for (const p of policies) {
      if (!live.some((l) => l.name === p.name && l.database === p.database && l.table === p.table)) continue;
      out.push({
        type: CLICKHOUSE_ENTITY_TYPES.rowPolicy,
        name: p.name,
        database: p.database!,
        table: p.table!,
        engine: "",
        statement: await first(`SHOW CREATE ROW POLICY ${ident(p.name)} ON ${ident(p.database!)}.${ident(p.table!)}`),
      });
    }
  }
  for (const name of grantees.filter((g) => existingUsers.has(g) || existingRoles.has(g))) {
    const lines = opts.withStatements === false ? [] : await all(`SHOW GRANTS FOR ${ident(name)}`);
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.grant, name, engine: "", statement: lines.join("\n") });
  }
  return out;
}

/** The canonical kinds a profile's `access` switch decides (#3716). */
export const ACCESS_KINDS: ReadonlySet<string> = new Set(["user", "role", "rowPolicy", "grants"]);

/** The entity types a profile's `access` switch decides (#3716). */
export const ACCESS_ENTITY_TYPES: ReadonlySet<string> = new Set([CLICKHOUSE_ENTITY_TYPES.user, CLICKHOUSE_ENTITY_TYPES.role, CLICKHOUSE_ENTITY_TYPES.rowPolicy, CLICKHOUSE_ENTITY_TYPES.grant]);

/** Why an access declaration is not read, planned or applied where the profile does not manage access. */
export const ACCESS_UNMANAGED_DETAIL = "access is not managed in this environment: set sql.profiles.<env>.access to plan and apply users, roles, row policies and grants";

/** The hint a plan gives for the access declarations it left out. */
export function accessUnmanagedHint(n: number, environment: string): string {
  return `${n} access declaration${n === 1 ? " is" : "s are"} not planned: ${environment}'s profile does not manage access (sql.profiles.<env>.access)`;
}

/** The access objects among declared canonical objects, for `readLiveAccess`. */
export function declaredAccess(objects: ReadonlyArray<{ kind: string; name: string; database?: string; table?: string }>): DeclaredAccess[] {
  return objects
    .filter((o) => ACCESS_KINDS.has(o.kind))
    .map((o) => ({ kind: o.kind, name: o.name, ...(o.database !== undefined ? { database: o.database } : {}), ...(o.table !== undefined ? { table: o.table } : {}) }));
}

/** The users, roles and row policies among declared entities, for `readLiveAccess`. */
export function accessOf(entities: ReadonlyMap<string, { entityType: string; props: Record<string, unknown> }>, defaultDatabase: string): DeclaredAccess[] {
  const kinds: Record<string, string> = { [CLICKHOUSE_ENTITY_TYPES.user]: "user", [CLICKHOUSE_ENTITY_TYPES.role]: "role", [CLICKHOUSE_ENTITY_TYPES.rowPolicy]: "rowPolicy" };
  const out: DeclaredAccess[] = [];
  for (const e of entities.values()) {
    const kind = kinds[e.entityType];
    if (!kind) continue;
    const name = String(e.props.name ?? "");
    if (kind === "rowPolicy") out.push({ kind, name, database: typeof e.props.database === "string" ? e.props.database : defaultDatabase, table: String(e.props.table ?? "") });
    else out.push({ kind, name });
  }
  return out;
}
