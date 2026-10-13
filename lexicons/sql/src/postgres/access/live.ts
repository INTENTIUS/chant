/**
 * Reading access from a live server (#3681): each target's access control
 * list, exploded into one entry per grantee (`aclexplode`, with
 * `acldefault` where the list is NULL, which means Postgres's own defaults),
 * the owner's own privileges left out; every column's list of a relation
 * read; and the default privileges (`pg_default_acl`) of the role that runs
 * the read and of the roles the declarations name with `FOR ROLE`, globally
 * and in the schemas in scope.
 */

import type { PostgresClient } from "../live/client";
import { addEntry, APPLYING_ROLE, builtinEntries, targetKey, type AccessState, type AclTarget, type DefaultObjects, type LiveAccess } from "./acl";

type Row = Record<string, unknown>;

const OBJTYPE: Readonly<Record<string, DefaultObjects>> = { r: "tables", S: "sequences", f: "functions", T: "types", n: "schemas" };

const GRANTEE = "CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(a.grantee) END";

export interface LiveAccessScope {
  /** The schemas whose default privileges are read; undefined is every schema. */
  schemas?: readonly string[];
  /** Roles besides the one that runs the read whose default privileges are read. */
  forRoles?: readonly string[];
  /** Global default-privilege targets the declarations decide: one with no row on the server holds Postgres's own defaults. */
  declaredDefaults?: readonly AclTarget[];
}

/** The access the server holds on `targets`, and the default privileges in scope. */
export async function readLiveAccess(client: PostgresClient, targets: readonly AclTarget[], scope: LiveAccessScope = {}): Promise<LiveAccess & { self: string }> {
  const state: AccessState = new Map();
  const present = new Set<string>();
  const [me] = await client.query<Row>("SELECT current_user AS self");
  const self = String(me?.self ?? "");
  const entry = (t: AclTarget, r: Row) => addEntry(state, t, String(r.grantee), String(r.privilege).toLowerCase(), r.grantable === true);

  const names = (kinds: readonly string[]) => [...new Set(targets.filter((t) => kinds.includes(t.kind)).map((t) => t.name))];

  const schemas = names(["schema"]);
  if (schemas.length > 0) {
    const rows = await client.query<Row>(
      `SELECT x AS target, ${GRANTEE} AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_catalog.unnest($1::text[]) x JOIN pg_catalog.pg_namespace n ON n.oid = pg_catalog.to_regnamespace(x)
       LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner))) a ON a.grantee <> n.nspowner`,
      [schemas],
    );
    for (const r of rows) {
      const t: AclTarget = { kind: "schema", name: String(r.target) };
      present.add(targetKey(t));
      if (r.privilege !== null) entry(t, r);
    }
  }

  const relations = names(["table", "sequence", "column"]);
  if (relations.length > 0) {
    const rows = await client.query<Row>(
      `SELECT x AS target, c.relkind AS kind, ${GRANTEE} AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_catalog.unnest($1::text[]) x JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(x)
       LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a ON a.grantee <> c.relowner`,
      [relations],
    );
    for (const r of rows) {
      const t: AclTarget = { kind: r.kind === "S" ? "sequence" : "table", name: String(r.target) };
      present.add(targetKey(t));
      if (r.privilege !== null) entry(t, r);
    }
    const columns = await client.query<Row>(
      `SELECT x AS target, att.attname AS column, ${GRANTEE} AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_catalog.unnest($1::text[]) x JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(x)
       JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped AND att.attacl IS NOT NULL
       CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
       WHERE a.grantee <> c.relowner`,
      [relations],
    );
    for (const r of columns) entry({ kind: "column", name: String(r.target), column: String(r.column) }, r);
  }

  const routines = names(["function", "procedure"]);
  if (routines.length > 0) {
    const rows = await client.query<Row>(
      `SELECT x AS target, p.prokind AS kind, ${GRANTEE} AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_catalog.unnest($1::text[]) x JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(x)
       LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))) a ON a.grantee <> p.proowner`,
      [routines],
    );
    for (const r of rows) {
      const t: AclTarget = { kind: r.kind === "p" ? "procedure" : "function", name: String(r.target) };
      present.add(targetKey(t));
      if (r.privilege !== null) entry(t, r);
    }
  }

  // Default privileges: the reading role's (written as the role that applies) and the FOR ROLE ones.
  const roles = [self, ...(scope.forRoles ?? [])];
  const defaults = await client.query<Row>(
    `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS role, n.nspname AS schema, d.defaclobjtype AS objtype,
            ${GRANTEE} AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
     FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
     LEFT JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ON a.grantee <> d.defaclrole
     WHERE pg_catalog.pg_get_userbyid(d.defaclrole) = ANY($1::text[])
       AND (d.defaclnamespace = 0${scope.schemas ? " OR n.nspname = ANY($2::text[])" : ""})`,
    scope.schemas ? [roles, [...scope.schemas]] : [roles],
  );
  const globalRows = new Set<string>();
  const globalDefaults = new Set<DefaultObjects>();
  for (const r of defaults) {
    const objects = OBJTYPE[String(r.objtype)];
    if (!objects) continue;
    const role = String(r.role) === self ? APPLYING_ROLE : String(r.role);
    const t: AclTarget = { kind: "default", name: "", role, ...(r.schema !== null && r.schema !== undefined ? { schema: String(r.schema) } : {}), objects };
    if (t.schema === undefined) {
      globalRows.add(targetKey(t));
      if (role === APPLYING_ROLE) globalDefaults.add(objects);
    }
    if (r.privilege !== null) entry(t, r);
  }
  // A global default the declarations decide with no row on the server is Postgres's own.
  for (const t of scope.declaredDefaults ?? []) {
    if (t.kind !== "default" || t.schema !== undefined || globalRows.has(targetKey(t))) continue;
    for (const b of builtinEntries(t.objects!)) addEntry(state, t, b.grantee, b.privilege, false);
  }
  return { state, present, globalDefaults, self };
}
