/**
 * Typed queries, one class per datasource plugin: `PromQuery` (PromQL),
 * `TempoQuery` (TraceQL) and `LokiQuery` (LogQL), each typed from that
 * plugin's query schema at `GRAFANA_SCHEMA_PIN`.
 *
 * The expression is a string; this lexicon does not parse PromQL, TraceQL or
 * LogQL. What it does check is where the query goes: `datasource` only
 * accepts a datasource of the query's own plugin type, and GRAF101, GRAF102
 * and GRAF103 check the emitted references after a build.
 *
 * `defineQuery` is the extension point for any other datasource plugin, and
 * the three built-ins are defined through it.
 */

import { createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { DatasourceEntity, DatasourceRef } from "./datasource";
import type { DatasourceVariableEntity } from "./variables";
import type { SchemaName } from "./pin";
import type { Dataquery as PrometheusDataquery } from "./schema/prometheus.gen";
import type { Dataquery as TempoDataquery } from "./schema/tempo.gen";
import type { Dataquery as LokiDataquery } from "./schema/loki.gen";

/** Where a query or panel sends its request: a declared datasource, a datasource variable, or the ref of one declared elsewhere. */
export type DatasourceInput<T extends string = string> = DatasourceEntity<T> | DatasourceVariableEntity<T> | DatasourceRef<T>;

/** A query model's fields, less what chant fills in (`datasource`, `refId` stays optional). */
export type QueryModel<M> = Omit<M, "datasource">;

export type QueryProps<M, T extends string> = QueryModel<M> & {
  /** Overrides the panel's datasource for this query. */
  datasource?: DatasourceInput<T>;
};

export interface QueryDefinition<T extends string = string, M = Record<string, unknown>> {
  /** The datasource plugin id this query is for. */
  datasourceType: T;
  /** The class name, for hover and docs. */
  className: string;
  description?: string;
  /** The vendored schema the model follows, when there is one (GRAF107 validates against it). */
  schema?: SchemaName;
  /** Which field holds the expression, for GRAF103 and hover. */
  expressionField?: string;
  /** Fields the schema requires that Grafana fills in anyway, written when the author leaves them out. */
  defaults?: Partial<M>;
  /** True only for the queries this package ships. */
  builtin: boolean;
}

export interface QueryEntity<T extends string = string, M = Record<string, unknown>> extends Declarable {
  readonly props: QueryProps<M, T>;
  readonly queryDefinition: QueryDefinition<T, M>;
}

export interface QueryClass<T extends string = string, M = Record<string, unknown>> {
  new (props: QueryProps<M, T>): QueryEntity<T, M>;
  readonly definition: QueryDefinition<T, M>;
}

export const QUERY_TYPE_PREFIX = "Grafana::Query::";

const REGISTRY_KEY = Symbol.for("chant.grafana.queryDefinitions");
function registry(): Map<string, QueryDefinition> {
  const g = globalThis as unknown as Record<symbol, Map<string, QueryDefinition> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

/** Every registered query definition, keyed by datasource type. */
export function registeredQueries(): QueryDefinition[] {
  return [...registry().values()];
}

export function queryDefinitionFor(datasourceType: string): QueryDefinition | undefined {
  return registry().get(datasourceType);
}

function makeQueryClass<T extends string, M>(def: QueryDefinition<T, M>): QueryClass<T, M> {
  const existing = registry().get(def.datasourceType);
  if (existing?.builtin && !def.builtin) {
    throw new Error(`grafana: queries for "${def.datasourceType}" are built in (${existing.className}); use that class.`);
  }
  registry().set(def.datasourceType, def as unknown as QueryDefinition);
  const Base = createProperty(`${QUERY_TYPE_PREFIX}${def.datasourceType}`, "grafana") as unknown as (
    this: object,
    props: Record<string, unknown>,
  ) => void;
  const Cls = function (this: object, props: Record<string, unknown>) {
    Base.call(this, props ?? {});
    Object.defineProperty(this, "queryDefinition", { value: def, enumerable: false });
  };
  Object.defineProperty(Cls, "name", { value: def.className });
  Object.defineProperty(Cls, "definition", { value: def, enumerable: false });
  return Cls as unknown as QueryClass<T, M>;
}

/**
 * Define a query class for a datasource plugin chant doesn't ship.
 *
 * @example
 * ```ts
 * interface ElasticQueryModel { query: string; metrics?: Array<{ type: string; id: string }>; refId?: string }
 *
 * export const ElasticQuery = defineQuery<ElasticQueryModel>()({
 *   datasourceType: "elasticsearch",
 *   className: "ElasticQuery",
 *   expressionField: "query",
 * });
 * ```
 */
export function defineQuery<M>() {
  return function <T extends string>(def: Omit<QueryDefinition<T, M>, "builtin">): QueryClass<T, M> {
    return makeQueryClass<T, M>({ ...def, builtin: false });
  };
}

export function isQueryEntity(value: unknown): value is QueryEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === "grafana" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(QUERY_TYPE_PREFIX)
  );
}

/** A Prometheus query: `expr` is PromQL. */
export const PromQuery = makeQueryClass<"prometheus", PrometheusDataquery>({
  datasourceType: "prometheus",
  className: "PromQuery",
  description: "A Prometheus query; expr is PromQL",
  schema: "prometheus",
  expressionField: "expr",
  builtin: true,
});

/** A Tempo query: `query` is TraceQL. `filters` defaults to none. */
export const TempoQuery = makeQueryClass<"tempo", Omit<TempoDataquery, "filters"> & Partial<Pick<TempoDataquery, "filters">>>({
  datasourceType: "tempo",
  className: "TempoQuery",
  description: "A Tempo query; query is TraceQL",
  schema: "tempo",
  expressionField: "query",
  defaults: { filters: [], queryType: "traceql" },
  builtin: true,
});

/** A Loki query: `expr` is LogQL. */
export const LokiQuery = makeQueryClass<"loki", LokiDataquery>({
  datasourceType: "loki",
  className: "LokiQuery",
  description: "A Loki query; expr is LogQL",
  schema: "loki",
  expressionField: "expr",
  builtin: true,
});

export type PromQueryEntity = InstanceType<typeof PromQuery>;
export type TempoQueryEntity = InstanceType<typeof TempoQuery>;
export type LokiQueryEntity = InstanceType<typeof LokiQuery>;
