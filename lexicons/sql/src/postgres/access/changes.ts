/**
 * The privilege changes a connected server needs (#3681): what `chant sql
 * plan` reports, and what the deep read reports as pending so the plan digest
 * an approval binds to moves with a privilege granted or revoked by hand
 * (#3706).
 */

import type { PostgresClient } from "../live/client";
import type { CanonicalPgObject } from "../plan/normalize";
import { declaredAccess, diffAccess, predictedAccess, targetKey, type AccessChange } from "./acl";
import { readLiveAccess } from "./live";

/** The role a session runs as: the one whose own privileges owning an object gives, and whose default privileges apply. */
async function currentRole(client: PostgresClient): Promise<{ self?: string }> {
  const rows = await client.query<{ self: string }>("SELECT current_user AS self").catch(() => []);
  return rows[0]?.self ? { self: rows[0].self } : {};
}

/**
 * The changes from the access the server holds to the access the
 * declarations (keyed by export name, in the build's order) add up to. An
 * object the server does not hold yet is taken to have what the server gives
 * a new one. `scope` limits the default privileges read to those schemas.
 */
export async function accessChangesAgainst(
  client: PostgresClient,
  declared: ReadonlyArray<{ key: string; canonical: CanonicalPgObject }>,
  options: { major: number; scope?: readonly string[] },
): Promise<AccessChange[]> {
  const want = declaredAccess(declared, { major: options.major, ...(await currentRole(client)) });
  const have = await readLiveAccess(client, want.targets, {
    ...(options.scope ? { schemas: options.scope } : {}),
    forRoles: want.forRoles,
    declaredDefaults: want.targets.filter((t) => t.kind === "default"),
  });
  const missing = want.targets.filter((t) => t.kind !== "default" && t.kind !== "column" && !have.present.has(targetKey(t)));
  const now = new Map([...have.state, ...predictedAccess(missing, have)]);
  return diffAccess(now, want.state, want.exportsOf);
}
