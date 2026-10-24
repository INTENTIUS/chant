/**
 * The plan's existence check for the named collections a build references
 * (#4395): by name, in `system.named_collections`, never the `collection`
 * or `create_query` columns, which hold the values.
 *
 * Checked against the pinned server (26.8.15.10): the table's columns are
 * `name`, `collection` (a `Map(String, String)`), `source` (`SQL` or
 * `Config`) and `create_query`. A user with `SHOW NAMED COLLECTIONS` and
 * without `SHOW NAMED COLLECTIONS SECRETS` sees every key, with each value as
 * `'[HIDDEN]'`, so keys could be compared without the secrets grant. A user
 * without `SHOW NAMED COLLECTIONS` reads the table without an error and sees
 * no rows; a collection that user cannot see is reported missing, with the
 * grant named.
 */

import { readFileSync } from "node:fs";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import type { NamedCollectionCheck } from "../plan/diff";

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The named collections a build output references (its document's `namedCollections`). */
export function referencedCollections(buildJson: string): string[] {
  const doc = JSON.parse(buildJson) as { namedCollections?: unknown };
  return Array.isArray(doc.namedCollections) ? doc.namedCollections.filter((n): n is string => typeof n === "string") : [];
}

/** {@link referencedCollections} of a build output file. */
export const referencedCollectionsOf = (buildFile: string): string[] => referencedCollections(readFileSync(buildFile, "utf-8"));

/** Which of `names` the server has, by name. Undefined when nothing is referenced. */
export async function checkNamedCollections(endpoint: ClickHouseEndpoint, names: readonly string[]): Promise<NamedCollectionCheck | undefined> {
  if (names.length === 0) return undefined;
  const referenced = [...new Set(names)].sort();
  try {
    const rows = await clickhouseQuery<{ name: string }>(
      endpoint,
      `/* chant plan: named collections */ SELECT name FROM system.named_collections WHERE name IN (${referenced.map(quote).join(", ")})`,
    );
    const have = new Set(rows.map((r) => r.name));
    return { referenced, missing: referenced.filter((n) => !have.has(n)) };
  } catch (err) {
    return { referenced, missing: referenced, unread: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

/** Whether the check fails the plan. */
export const namedCollectionsFail = (c: NamedCollectionCheck | undefined): boolean => c !== undefined && c.missing.length > 0;

/** The report's lines for a failed check; none when it passed. */
export function renderNamedCollections(c: NamedCollectionCheck | undefined): string[] {
  if (!c || c.missing.length === 0) return [];
  if (c.unread !== undefined) {
    return ["", `Refused: the build references named collection(s) ${c.missing.join(", ")}, and the server's could not be read to check them: ${c.unread}`];
  }
  return [
    "",
    `Refused: the build references ${c.missing.length === 1 ? "a named collection" : "named collections"} the server does not have: ${c.missing.join(", ")}. ` +
      "Create each on the server (chant never declares one), or grant the plan's user SHOW NAMED COLLECTIONS if it is there and hidden from that user.",
  ];
}
