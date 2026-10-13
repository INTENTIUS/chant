/**
 * Import's access (#3681): the privileges on the imported objects, and the
 * default privileges of the role that reads, as `grant` declarations. Each
 * is the GRANT, REVOKE or ALTER DEFAULT PRIVILEGES that takes what Postgres
 * gives a new object (EXECUTE to PUBLIC on a routine, nothing on the rest) to
 * what the server holds, one per object and grantee, so the import plans as
 * no change.
 */

import type { PostgresClient } from "../live/client";
import type { LivePgObject } from "../live/catalog";
import type { ImportedPgObject } from "../import/ir";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import { quoteIdent } from "../keywords";
import { builtinEntries, diffAccess, entryKey, targetKey, type AccessState, type AclTarget } from "./acl";
import { readLiveAccess } from "./live";

/** The access targets of imported objects, named as the catalog read names them. */
function targetsOf(objects: readonly LivePgObject[]): AclTarget[] {
  const out: AclTarget[] = [];
  for (const o of objects) {
    const name = `${o.schema ? `${quoteIdent(o.schema)}.` : ""}${quoteIdent(o.name)}`;
    if (o.type === POSTGRES_ENTITY_TYPES.schema) out.push({ kind: "schema", name: quoteIdent(o.name) });
    else if (o.type === POSTGRES_ENTITY_TYPES.table || o.type === POSTGRES_ENTITY_TYPES.view || o.type === POSTGRES_ENTITY_TYPES.materializedView) out.push({ kind: "table", name });
    else if (o.type === POSTGRES_ENTITY_TYPES.sequence) out.push({ kind: "sequence", name });
    else if (o.type === POSTGRES_ENTITY_TYPES.function || o.type === POSTGRES_ENTITY_TYPES.procedure) {
      out.push({ kind: o.type === POSTGRES_ENTITY_TYPES.function ? "function" : "procedure", name: `${name}${o.signature ?? ""}` });
    }
  }
  return out;
}

const word = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

export async function importedAccess(client: PostgresClient, objects: readonly LivePgObject[], schemas: readonly string[] | undefined): Promise<ImportedPgObject[]> {
  const targets = targetsOf(objects);
  const live = await readLiveAccess(client, targets, schemas ? { schemas } : {});
  // What a new object is given: the starting point each declaration takes to the server's.
  const baseline: AccessState = new Map();
  for (const t of targets) {
    for (const b of builtinEntries(t.kind)) baseline.set(entryKey(t, b.grantee), { target: t, grantee: b.grantee, privileges: new Map([[b.privilege, false]]) });
  }
  for (const e of live.state.values()) {
    if (e.target.kind !== "default" || e.target.schema !== undefined) continue;
    for (const b of builtinEntries(e.target.objects!)) {
      const k = entryKey(e.target, b.grantee);
      if (!baseline.has(k)) baseline.set(k, { target: e.target, grantee: b.grantee, privileges: new Map([[b.privilege, false]]) });
    }
  }
  // Only global default rows that exist on the server are compared from Postgres's own defaults.
  const globalRows = new Set([...live.state.values()].filter((e) => e.target.kind === "default").map((e) => targetKey(e.target)));
  const from = new Map([...baseline].filter(([, e]) => e.target.kind !== "default" || globalRows.has(targetKey(e.target))));
  return diffAccess(from, live.state).flatMap((c) =>
    c.sql.map((sql, i) => {
      const defaults = c.target.kind === "default";
      const on = defaults ? `default_${c.target.schema ?? "all"}_${c.target.objects}` : c.target.name.replace(/\(.*$/, "").split(".").pop()!;
      return {
        type: defaults ? POSTGRES_ENTITY_TYPES.defaultPrivileges : POSTGRES_ENTITY_TYPES.grant,
        name: word(`${/^REVOKE|^ALTER DEFAULT PRIVILEGES.* REVOKE /.test(sql) ? "revoke" : "grant"}_${on}${c.target.column ? `_${c.target.column}` : ""}_${c.grantee}${i > 0 ? `_${i}` : ""}`),
        ddl: sql,
      };
    }),
  );
}
