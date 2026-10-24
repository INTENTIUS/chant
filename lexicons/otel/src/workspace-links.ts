/**
 * The workspace links an otel member's declarations state (#4397): each
 * table a `clickhouse` exporter writes, and each column its insert names, as
 * a link to the sql member that declares them (#3931).
 *
 * | Link | Output |
 * |---|---|
 * | the table | `<database>.<table>` |
 * | a column | `<database>.<table>.<column>`, anchored on the table |
 *
 * The exporter's config does not name the sql member, so each link is
 * matched to the one member that exposes the table (`resolveLinks` in
 * chant's `workspace/links.ts`). `chant workspace check` then fails (WSP093)
 * when a table the exporter writes, or a column its insert names, is renamed
 * or dropped in the sql member. The tables and columns come from
 * `clickhouse-tables.ts`, which OTEL129 reads in one build root.
 *
 * A config value chant can't read without the environment, such as a
 * database set from `${env:CH_DB}`, is a gap (WSP099), and the tables it
 * names are not linked.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { LexiconWorkspaceLink, LexiconWorkspaceLinks } from "@intentius/chant/graph-ir";
import { clickhouseExportersOf } from "./clickhouse-tables";
import { collectorConfig } from "./collector";
import type { OTelComponent } from "./define";

export function otelWorkspaceLinks(entities: ReadonlyMap<string, Declarable>): LexiconWorkspaceLinks | undefined {
  const keyOf = new Map<string, string>();
  for (const [key, e] of entities) {
    const c = e as Partial<OTelComponent>;
    if (c.componentKind === "exporter" && c.componentType === "clickhouse" && typeof c.componentId === "string") keyOf.set(c.componentId, key);
  }
  if (keyOf.size === 0) return undefined;

  const links: LexiconWorkspaceLink[] = [];
  const gaps: string[] = [];
  for (const exp of clickhouseExportersOf(collectorConfig(entities.values()))) {
    const entity = keyOf.get(exp.id) ?? exp.id;
    for (const u of exp.unread) gaps.push(`exporter ${exp.id} (${entity}) sets ${u}, which is read from the environment, so the tables it names are not linked`);
    for (const t of exp.tables) {
      const table = `${exp.database}.${t.name}`;
      links.push({ output: table, entity });
      for (const column of t.columns) links.push({ output: `${table}.${column}`, anchor: table, entity });
    }
  }
  if (links.length === 0 && gaps.length === 0) return undefined;
  return { links, ...(gaps.length ? { gaps } : {}) };
}
