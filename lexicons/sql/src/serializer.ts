/**
 * The sql serializer.
 *
 * A build writes two things:
 *
 * - The primary output, one JSON document: the dialect, the order objects
 *   must be created in, and each object filed under its export name (its
 *   identity in chant) with its type, its parsed definition, the references it
 *   makes and its DDL. Post-synth checks, planning and the applier read this.
 * - `clickhouse.sql` beside it: every statement, in that order, as it will be
 *   sent. Written verbatim.
 *
 * The order is the dependency order of the references: a view after the
 * tables it reads, a materialized view after its target, a table after its
 * database. Ties break by export name, so the output is the same however the
 * files were discovered. A reference cycle is an error naming the cycle.
 *
 * Rule ids: `SQL` for rules that hold in every dialect, `SQLCH` for the
 * ClickHouse dialect's (#3199).
 */

import type { Declarable, Serializer, SerializerResult } from "@intentius/chant";
import { isClickHouseObject, type ClickHouseObject } from "./clickhouse/entities";
import { applyOrder, lineageJson, referenceName, type LineageEdge } from "./core/references";

export { applyOrder } from "./core/references";

/** The file the statements are written to, beside the primary output. */
export const CLICKHOUSE_DDL_FILE = "clickhouse.sql";

function objectJson(name: string, obj: ClickHouseObject, names: Map<Declarable, string>): Record<string, unknown> {
  const props = { ...(obj.props as Record<string, unknown>) };
  delete props.source;
  const ddl = props.ddl;
  delete props.ddl;
  if (props.reads) props.reads = (props.reads as unknown[]).map((r) => referenceName(r, names) ?? null);
  if (props.to !== undefined && typeof props.to !== "string") props.to = referenceName(props.to, names) ?? null;
  if (props.lineage) {
    props.lineage = lineageJson(props.lineage as LineageEdge[], names);
  }
  const dependsOn = [...new Set(obj.dependsOn.map((r) => referenceName(r, names)).filter((n) => n !== undefined))];
  return JSON.parse(
    JSON.stringify({ export: name, type: obj.entityType, sqlName: obj.sqlName, ...props, dependsOn, ddl }),
  ) as Record<string, unknown>;
}

export const sqlSerializer: Serializer = {
  name: "sql",
  rulePrefix: "SQL",

  serialize(entities: Map<string, Declarable>): string | SerializerResult {
    const objects = new Map<string, ClickHouseObject>();
    for (const [name, entity] of entities) if (isClickHouseObject(entity)) objects.set(name, entity);
    if (objects.size === 0) return "";

    const names = new Map<Declarable, string>();
    for (const [name, entity] of entities) names.set(entity, name);

    const order = applyOrder(objects, names);
    const doc = {
      dialect: "clickhouse",
      applyOrder: order,
      objects: order.map((n) => objectJson(n, objects.get(n)!, names)),
    };
    const ddl = order
      .map((n) => `${(objects.get(n)!.props as { ddl: string }).ddl};`)
      .join("\n\n");
    return {
      primary: `${JSON.stringify(doc, null, 2)}\n`,
      files: { [CLICKHOUSE_DDL_FILE]: `${ddl}\n` },
      verbatimFiles: [CLICKHOUSE_DDL_FILE],
    };
  },
};
