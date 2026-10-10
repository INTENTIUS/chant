/**
 * The two sides a diff compares: a build's output (the declarations), or what
 * a live server reports.
 */

import { readFileSync } from "node:fs";
import { canonicalObject, grantsObject, liveCanonical, objectKey, scopeOf } from "./normalize";
import { grantsByGrantee } from "../access";
import type { SchemaObject, UnreadableEntry } from "./diff";
import type { ClickHouseTarget } from "../live/bind";
import { readLiveAccess, readLiveSchema, type DeclaredAccess } from "../live/catalog";
import { renderFor, type Topology } from "../topology";

interface OutputDoc {
  dialect?: string;
  objects?: Array<{ export: string; ddl: string; type?: string }>;
}

/** The objects a `chant build` output holds, keyed by export name; with a `topology`, each declaration as rendered for it (`../topology.ts`). */
export function schemaFromBuildOutput(json: string, defaultDatabase = "default", topology?: Topology): SchemaObject[] {
  const doc = JSON.parse(json) as OutputDoc;
  if (doc.dialect !== "clickhouse" || !Array.isArray(doc.objects)) {
    throw new Error("not a sql lexicon build output: expected { dialect: \"clickhouse\", objects: [...] }");
  }
  const out: SchemaObject[] = doc.objects
    .filter((o) => o.type !== "ClickHouse::Grant")
    .map((o) => ({ key: o.export, canonical: canonicalObject(renderFor(o.ddl, topology), defaultDatabase) }));
  // Grants are compared per grantee (`../access.ts`).
  for (const g of grantsByGrantee(doc.objects.map((o) => ({ ...o, type: o.type ?? "" })))) {
    const canonical = grantsObject(g.ddl, g.grantee, defaultDatabase);
    out.push({ key: objectKey(canonical), canonical });
  }
  return out;
}

export function schemaFromBuildFile(path: string, defaultDatabase = "default", topology?: Topology): SchemaObject[] {
  return schemaFromBuildOutput(readFileSync(path, "utf-8"), defaultDatabase, topology);
}

/**
 * The declared objects re-keyed by `database.name`, the only identity a live
 * server has. The export name is kept for the report.
 */
export function keyedByQualifiedName(objects: readonly SchemaObject[]): Array<SchemaObject & { exportName: string }> {
  return objects.map((o) => ({
    key: objectKey(o.canonical),
    canonical: o.canonical,
    exportName: o.key,
  }));
}

/**
 * What the server holds, keyed by `database.name`, limited to the databases
 * the declarations use (and the target's scope) and the functions they
 * declare (`scopeOf`). The `default` database is
 * left out, as import leaves it out. An object whose definition chant cannot
 * read is not left out silently (#3653): it goes in `unreadable`, when
 * given, and otherwise fails the read.
 */
export async function schemaFromServer(
  target: ClickHouseTarget,
  databases?: ReadonlySet<string>,
  unreadable?: UnreadableEntry[],
  access: readonly DeclaredAccess[] = [],
): Promise<SchemaObject[]> {
  const live = [...(await readLiveSchema(target)), ...(await readLiveAccess(target, access))];
  const out: SchemaObject[] = [];
  for (const o of live) {
    if (o.type === "ClickHouse::Database" && o.name === "default") continue;
    if (databases && !databases.has(scopeOf(o))) continue;
    const key = objectKey(o);
    try {
      out.push({ key, canonical: liveCanonical(o, target.defaultDatabase) });
    } catch (err) {
      if (!unreadable) throw err;
      unreadable.push({ object: key, type: o.type, reason: `its definition does not parse: ${(err as Error).message}` });
    }
  }
  return out;
}
