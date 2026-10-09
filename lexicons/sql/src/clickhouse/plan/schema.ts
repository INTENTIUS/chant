/**
 * The two sides a diff compares: a build's output (the declarations), or what
 * a live server reports.
 */

import { readFileSync } from "node:fs";
import { canonicalObject } from "./normalize";
import type { SchemaObject } from "./diff";
import type { ClickHouseTarget } from "../live/bind";
import { readLiveSchema } from "../live/catalog";
import { renderFor, type Topology } from "../topology";

interface OutputDoc {
  dialect?: string;
  objects?: Array<{ export: string; ddl: string }>;
}

/** The objects a `chant build` output holds, keyed by export name; with a `topology`, each declaration as rendered for it (`../topology.ts`). */
export function schemaFromBuildOutput(json: string, defaultDatabase = "default", topology?: Topology): SchemaObject[] {
  const doc = JSON.parse(json) as OutputDoc;
  if (doc.dialect !== "clickhouse" || !Array.isArray(doc.objects)) {
    throw new Error("not a sql lexicon build output: expected { dialect: \"clickhouse\", objects: [...] }");
  }
  return doc.objects.map((o) => ({ key: o.export, canonical: canonicalObject(renderFor(o.ddl, topology), defaultDatabase) }));
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
    key: o.canonical.database ? `${o.canonical.database}.${o.canonical.name}` : o.canonical.name,
    canonical: o.canonical,
    exportName: o.key,
  }));
}

/**
 * What the server holds, keyed by `database.name`, limited to the databases
 * the declarations use (and the target's scope). The `default` database is
 * left out, as import leaves it out.
 */
export async function schemaFromServer(target: ClickHouseTarget, databases?: ReadonlySet<string>): Promise<SchemaObject[]> {
  const live = await readLiveSchema(target);
  return live
    .filter((o) => !(o.type === "ClickHouse::Database" && o.name === "default"))
    .filter((o) => !databases || databases.has(o.database ?? o.name))
    .map((o) => ({
      key: o.database ? `${o.database}.${o.name}` : o.name,
      canonical: canonicalObject(o.statement, target.defaultDatabase),
    }));
}
