/**
 * The ClickHouse catalog the editor and the MCP tools read: the committed
 * snapshot of the pinned server's `system.*` tables, parsed once and indexed
 * by name. No server is needed; the snapshot is what generation reads too.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseCatalog, type ClickHouseCatalog, type SettingRow } from "../spec/catalog";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "clickhouse-catalog.snapshot.json");

export interface CatalogIndex {
  catalog: ClickHouseCatalog;
  /** Name lookups. Names a server treats case-insensitively are also keyed lowercased. */
  engines: Map<string, ClickHouseCatalog["tableEngines"][number]>;
  databaseEngines: Map<string, ClickHouseCatalog["databaseEngines"][number]>;
  types: Map<string, ClickHouseCatalog["typeFamilies"][number]>;
  codecs: Map<string, ClickHouseCatalog["codecs"][number]>;
  indexTypes: Map<string, ClickHouseCatalog["skipIndexTypes"][number]>;
  mergeTreeSettings: Map<string, SettingRow>;
  querySettings: Map<string, SettingRow>;
  functions: Map<string, ClickHouseCatalog["functions"][number]>;
  formats: Map<string, ClickHouseCatalog["formats"][number]>;
}

let cached: CatalogIndex | null = null;

const byName = <T extends { name: string }>(rows: readonly T[], foldCase?: (row: T) => boolean): Map<string, T> => {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.name, row);
    if (foldCase?.(row)) map.set(row.name.toLowerCase(), row);
  }
  return map;
};

/** The catalog, or undefined when the snapshot cannot be read. */
export function catalogIndex(): CatalogIndex | undefined {
  if (cached) return cached;
  try {
    const catalog = parseCatalog(readFileSync(SNAPSHOT, "utf-8"));
    cached = {
      catalog,
      engines: byName(catalog.tableEngines),
      databaseEngines: byName(catalog.databaseEngines),
      types: byName(catalog.typeFamilies, (t) => t.caseInsensitive),
      codecs: byName(catalog.codecs),
      indexTypes: byName(catalog.skipIndexTypes),
      mergeTreeSettings: byName(catalog.mergeTreeSettings),
      querySettings: byName(catalog.querySettings),
      functions: byName(catalog.functions, (f) => f.caseInsensitive),
      formats: byName(catalog.formats),
    };
    return cached;
  } catch {
    return undefined;
  }
}
