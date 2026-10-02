/**
 * The entity registry, `lexicon-sql.json`: one entry per entity kind, which the
 * LSP completes and hovers from and `dist/meta.json` packages.
 *
 * The ClickHouse entities are hand-written: their shape is the DDL a tag
 * parses, not a schema document. Each is keyed by the kind's name and points
 * at the entity type the tag gives it.
 */

import { CLICKHOUSE_ENTITY_TYPES } from "../clickhouse/entities";

const KINDS: Record<string, string> = {
  Database: CLICKHOUSE_ENTITY_TYPES.database,
  Table: CLICKHOUSE_ENTITY_TYPES.table,
  View: CLICKHOUSE_ENTITY_TYPES.view,
  MaterializedView: CLICKHOUSE_ENTITY_TYPES.materializedView,
};

export function buildRegistry(): string {
  const registry = Object.fromEntries(
    Object.entries(KINDS).map(([name, resourceType]) => [name, { resourceType, kind: "resource", lexicon: "sql" }]),
  );
  return `${JSON.stringify(registry, null, 2)}\n`;
}
