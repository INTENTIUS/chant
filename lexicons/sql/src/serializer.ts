/**
 * The sql serializer.
 *
 * A build writes two things:
 *
 * - The primary output, one JSON document: the dialect, the order objects
 *   must be created in, and each object filed under its export name (its
 *   identity in chant) with its type, its parsed definition, the references it
 *   makes and its DDL. Post-synth checks, planning and the applier read this.
 * - `clickhouse.sql` (or `postgres.sql`) beside it: every statement, in that
 *   order, as it will be sent. Written verbatim.
 *
 * The order is the dependency order of the references: a view after the
 * tables it reads, a materialized view after its target, a table after its
 * database. Ties break by export name, so the output is the same however the
 * files were discovered. A reference cycle is an error naming the cycle.
 *
 * One build holds one dialect: the dialect is the document's, and a project
 * whose declarations are ClickHouse and Postgres both is refused, naming one
 * of each. Two databases of different dialects are two projects (two
 * workspace members, #3047 question 1).
 *
 * A Postgres document also carries `postgresMajor`, the major the project
 * targets (`sql.postgresMajor`, else the newest pinned major). Post-synth
 * checks and the lock classifier read it; ClickHouse output has no such field.
 *
 * Rule ids: `SQL` for rules that hold in every dialect, `SQLCH` for the
 * ClickHouse dialect's (#3199), `SQLPG` for Postgres's (#3289).
 */

import type { Declarable, Serializer, SerializerResult } from "@intentius/chant";
import type { SerializeContext } from "@intentius/chant/serializer";
import { isAttrRefLike } from "@intentius/chant/utils";
import { isClickHouseObject, type ClickHouseObject } from "./clickhouse/entities";
import { isPostgresObject, type PostgresObject } from "./postgres/entities";
import { POSTGRES_LATEST_MAJOR } from "./spec/postgres-pin";
import { applyOrder, lineageJson, referenceName, type LineageEdge } from "./core/references";

export { applyOrder } from "./core/references";

/** The file the statements are written to, beside the primary output. */
export const CLICKHOUSE_DDL_FILE = "clickhouse.sql";

/** The Postgres statements' file, beside the primary output. */
export const POSTGRES_DDL_FILE = "postgres.sql";

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

/** A props value with every entity and column reference in it written as its export name (`users`, `users.id`). */
function postgresJsonValue(v: unknown, names: Map<Declarable, string>): unknown {
  if (isPostgresObject(v) || isAttrRefLike(v)) return referenceName(v, names) ?? null;
  if (Array.isArray(v)) return v.map((x) => postgresJsonValue(x, names));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, postgresJsonValue(x, names)]));
  return v;
}

function postgresObjectJson(name: string, obj: PostgresObject, names: Map<Declarable, string>): Record<string, unknown> {
  const props = { ...(obj.props as Record<string, unknown>) };
  delete props.source;
  const ddl = props.ddl;
  delete props.ddl;
  const dependsOn = [...new Set(obj.dependsOn.map((r) => referenceName(r, names)).filter((n) => n !== undefined))];
  return JSON.parse(
    JSON.stringify({ export: name, type: obj.entityType, sqlName: obj.sqlName, ...(postgresJsonValue(props, names) as object), dependsOn, ddl }),
  ) as Record<string, unknown>;
}

/** The Postgres major the build targets: `sql.postgresMajor`, else the newest pinned major. */
function targetMajor(config: Record<string, unknown> | undefined): number {
  const m = (config?.sql as { postgresMajor?: unknown } | undefined)?.postgresMajor;
  return typeof m === "number" ? m : POSTGRES_LATEST_MAJOR;
}

function serializePostgres(
  objects: Map<string, PostgresObject>,
  entities: Map<string, Declarable>,
  config?: Record<string, unknown>,
): SerializerResult {
  const names = new Map<Declarable, string>();
  for (const [name, entity] of entities) names.set(entity, name);
  const order = applyOrder(objects, names);
  const doc = {
    dialect: "postgres",
    postgresMajor: targetMajor(config),
    applyOrder: order,
    objects: order.map((n) => postgresObjectJson(n, objects.get(n)!, names)),
  };
  const ddl = order.map((n) => `${(objects.get(n)!.props as { ddl: string }).ddl};`).join("\n\n");
  return {
    primary: `${JSON.stringify(doc, null, 2)}\n`,
    files: { [POSTGRES_DDL_FILE]: `${ddl}\n` },
    verbatimFiles: [POSTGRES_DDL_FILE],
  };
}

export const sqlSerializer: Serializer = {
  name: "sql",
  rulePrefix: "SQL",

  serialize(entities: Map<string, Declarable>, _outputs?: unknown, context?: SerializeContext): string | SerializerResult {
    const objects = new Map<string, ClickHouseObject>();
    const postgres = new Map<string, PostgresObject>();
    for (const [name, entity] of entities) {
      if (isClickHouseObject(entity)) objects.set(name, entity);
      else if (isPostgresObject(entity)) postgres.set(name, entity);
    }
    if (objects.size > 0 && postgres.size > 0) {
      throw new Error(
        `sql: one build holds one dialect, and this one declares ClickHouse (${[...objects.keys()][0]}) and Postgres (${[...postgres.keys()][0]}) objects; ` +
          "declare each database in its own project",
      );
    }
    if (postgres.size > 0) return serializePostgres(postgres, entities, context?.config);
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
