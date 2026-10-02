/**
 * The entity registry, `lexicon-sql.json`: one entry per declarable class the
 * package exports, which the LSP completes and hovers from and `dist/meta.json`
 * packages.
 *
 * The ClickHouse entities (database, table, view, materialized view) are
 * hand-written, not generated: their shape is the DDL a tag parses, not a
 * schema document. They land with the entity model (chant #3197), and register
 * here from that catalog. Until then the registry is empty.
 */

export function buildRegistry(): string {
  return `${JSON.stringify({}, null, 2)}\n`;
}
