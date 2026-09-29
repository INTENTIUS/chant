/**
 * Typed queries, one class per datasource plugin. `PromQuery` (PromQL),
 * `TempoQuery` (TraceQL), `LokiQuery` (LogQL), `ElasticsearchQuery`,
 * `CloudWatchQuery`, `AzureMonitorQuery`, `CloudMonitoringQuery`,
 * `BigQueryQuery` and `PyroscopeQuery` are typed from that plugin's query
 * schema at `GRAFANA_SCHEMA_PIN`. `PostgresQuery`, `MySQLQuery` and
 * `MSSQLQuery` have no schema upstream and are typed by hand from Grafana's
 * source (`./query-models.ts`).
 *
 * The expression is a string. What the lexicon checks is where the query
 * goes: `datasource` only accepts a datasource of the query's own plugin
 * type, and GRAF101, GRAF102 and GRAF103 check the emitted references after
 * a build. GRAF108 parses the PromQL of every query that reaches a
 * Prometheus; TraceQL and LogQL are not parsed.
 *
 * `defineQuery` is the extension point for any other datasource plugin, and
 * the three built-ins are defined through it.
 */

import { createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { DatasourceEntity, DatasourceRef, ExternalDatasourceEntity } from "./datasource";
import type { DatasourceVariableEntity } from "./variables";
import type { SchemaName } from "./pin";
import type { Dataquery as PrometheusDataquery } from "./schema/prometheus.gen";
import type { Dataquery as TempoDataquery } from "./schema/tempo.gen";
import type { Dataquery as LokiDataquery } from "./schema/loki.gen";
import type { Dataquery as ElasticsearchDataquery } from "./schema/elasticsearch.gen";
import type { Request as CloudWatchRequest } from "./schema/cloudwatch.gen";
import type { MonitorQuery as AzureMonitorDataquery } from "./schema/azuremonitor.gen";
import type { CloudMonitoringQuery as CloudMonitoringDataquery } from "./schema/googlecloudmonitoring.gen";
import type { Dataquery as BigQueryDataquery } from "./schema/bigquery.gen";
import type { Dataquery as PyroscopeDataquery } from "./schema/grafanapyroscope.gen";
import type { SqlQueryModel } from "./query-models";

/** Where a query or panel sends its request: a declared or external datasource, a datasource variable, or the ref of one declared elsewhere. */
export type DatasourceInput<T extends string = string> =
  | DatasourceEntity<T>
  | ExternalDatasourceEntity<T>
  | DatasourceVariableEntity<T>
  | DatasourceRef<T>;

/**
 * A query model's fields, less what chant fills in (`datasource`, `refId`
 * stays optional). A model that is a union (CloudWatch's metrics, logs and
 * annotation queries) stays one, member by member.
 */
export type QueryModel<M> = M extends unknown ? Omit<M, "datasource"> : never;

/** `M` with the fields `K` optional, member by member: for fields a schema requires that Grafana fills in when they are missing. */
export type Loosen<M, K extends PropertyKey> = M extends unknown ? Omit<M, K> & Partial<Pick<M, K & keyof M>> : never;

type KeysOfUnion<U> = U extends unknown ? keyof U : never;

/**
 * A union of models as one object type: every member's fields, each
 * optional, typed as the union of what the members allow there. A class
 * whose props are a union could not have a single prop named by
 * `PropsOf<typeof Class>["key"]`, which is how imported source types its
 * lifted consts.
 */
export type MergedModel<U> = { [K in KeysOfUnion<U>]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never };

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
  /**
   * Other plugin ids Grafana accepts for the same plugin (`aliasIDs` in its
   * plugin.json), e.g. `postgres` for `grafana-postgresql-datasource`. The
   * class is registered under each, so imports and GRAF107 find it by either.
   */
  aliases?: readonly string[];
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

/** Every registered query definition, once each (a definition with aliases is registered under several types). */
export function registeredQueries(): QueryDefinition[] {
  return [...new Set(registry().values())];
}

export function queryDefinitionFor(datasourceType: string): QueryDefinition | undefined {
  return registry().get(datasourceType);
}

function makeQueryClass<T extends string, M>(def: QueryDefinition<T, M>): QueryClass<T, M> {
  const existing = registry().get(def.datasourceType);
  if (existing?.builtin && !def.builtin) {
    throw new Error(`grafana: queries for "${def.datasourceType}" are built in (${existing.className}); use that class.`);
  }
  for (const type of [def.datasourceType, ...(def.aliases ?? [])]) registry().set(type, def as unknown as QueryDefinition);
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
 * interface OpenSearchQueryModel { query: string; queryType?: "lucene" | "PPL"; refId?: string }
 *
 * export const OpenSearchQuery = defineQuery<OpenSearchQueryModel>()({
 *   datasourceType: "grafana-opensearch-datasource",
 *   className: "OpenSearchQuery",
 *   expressionField: "query",
 * });
 * ```
 */
export function defineQuery<M = Record<string, unknown>>() {
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

/**
 * An Elasticsearch query: `query` is Lucene (or the query string of a raw
 * data, raw document or logs query), `metrics` and `bucketAggs` the
 * aggregations.
 */
export const ElasticsearchQuery = makeQueryClass<"elasticsearch", ElasticsearchDataquery>({
  datasourceType: "elasticsearch",
  className: "ElasticsearchQuery",
  description: "An Elasticsearch query; query is Lucene, metrics and bucketAggs the aggregations",
  schema: "elasticsearch",
  expressionField: "query",
  builtin: true,
});

/**
 * A CloudWatch query: a metrics query (`queryMode: "Metrics"`), a Logs
 * Insights query (`queryMode: "Logs"`, `expression` in `queryLanguage`) or an
 * annotation query. The three schema definitions are merged into one type
 * with every field but `queryMode` optional, so each field is one prop;
 * GRAF107 checks the fields against the three definitions. Grafana's editor
 * starts `id` and `region` at `""` and `"default"`
 * (public/app/plugins/datasource/cloudwatch/defaultQueries.ts:12-27 and
 * 41-52 at v13.2.2), and the backend reads a missing region as the
 * datasource's default (pkg/tsdb/cloudwatch/cloudwatch.go:65).
 */
export const CloudWatchQuery = makeQueryClass<"cloudwatch", MergedModel<CloudWatchRequest> & Pick<CloudWatchRequest, "queryMode">>({
  datasourceType: "cloudwatch",
  className: "CloudWatchQuery",
  description: "A CloudWatch metrics, Logs Insights or annotation query, by queryMode",
  schema: "cloudwatch",
  expressionField: "expression",
  builtin: true,
});

/**
 * An Azure Monitor query: `queryType` picks which of `azureMonitor`,
 * `azureLogAnalytics` (KQL), `azureResourceGraph` or `azureTraces` holds it.
 */
export const AzureMonitorQuery = makeQueryClass<"grafana-azure-monitor-datasource", AzureMonitorDataquery>({
  datasourceType: "grafana-azure-monitor-datasource",
  className: "AzureMonitorQuery",
  description: "An Azure Monitor metrics, Log Analytics (KQL), Resource Graph or traces query, by queryType",
  schema: "azuremonitor",
  builtin: true,
});

/**
 * A Google Cloud Monitoring query (plugin id `stackdriver`): `queryType`
 * picks which of `timeSeriesList`, `timeSeriesQuery` (MQL), `sloQuery` or
 * `promQLQuery` holds it.
 */
export const CloudMonitoringQuery = makeQueryClass<"stackdriver", CloudMonitoringDataquery>({
  datasourceType: "stackdriver",
  className: "CloudMonitoringQuery",
  description: "A Google Cloud Monitoring time series, MQL, SLO or PromQL query, by queryType",
  schema: "googlecloudmonitoring",
  builtin: true,
});

/**
 * A BigQuery query: `rawSql` is GoogleSQL. `format` and `rawSql` may be left
 * out: the plugin fills in `table` and `""` (src/utils.ts:147-160 in
 * grafana/google-bigquery-datasource v3.4.2).
 */
export const BigQueryQuery = makeQueryClass<"grafana-bigquery-datasource", Loosen<BigQueryDataquery, "format" | "rawSql">>({
  datasourceType: "grafana-bigquery-datasource",
  className: "BigQueryQuery",
  description: "A BigQuery query; rawSql is GoogleSQL",
  schema: "bigquery",
  expressionField: "rawSql",
  builtin: true,
});

/**
 * A Grafana Pyroscope query: `labelSelector` selects the profiles of
 * `profileTypeId`. `labelSelector` and `groupBy` may be left out: the plugin
 * starts them at `{}` and none (dataquery.ts:67-75 and datasource.ts:156-164
 * in grafana-pyroscope-datasource 13.0.4, the version bundled with
 * grafana/grafana:13.2.2).
 */
export const PyroscopeQuery = makeQueryClass<"grafana-pyroscope-datasource", Loosen<PyroscopeDataquery, "labelSelector" | "groupBy">>({
  datasourceType: "grafana-pyroscope-datasource",
  className: "PyroscopeQuery",
  description: "A Grafana Pyroscope profile or metrics query; labelSelector selects the profiles",
  schema: "grafanapyroscope",
  expressionField: "labelSelector",
  builtin: true,
});

/**
 * A PostgreSQL query: `rawSql` is SQL with Grafana's macros. Also used for
 * the plugin's old id, `postgres` (an `aliasIDs` entry in the plugin.json of
 * grafana-postgresql-datasource 13.0.3, bundled with grafana/grafana:13.2.2).
 */
export const PostgresQuery = makeQueryClass<"grafana-postgresql-datasource" | "postgres", SqlQueryModel>({
  datasourceType: "grafana-postgresql-datasource",
  aliases: ["postgres"],
  className: "PostgresQuery",
  description: "A PostgreSQL query; rawSql is SQL with Grafana's macros",
  expressionField: "rawSql",
  builtin: true,
});

/** A MySQL query: `rawSql` is SQL with Grafana's macros. */
export const MySQLQuery = makeQueryClass<"mysql", SqlQueryModel>({
  datasourceType: "mysql",
  className: "MySQLQuery",
  description: "A MySQL query; rawSql is SQL with Grafana's macros",
  expressionField: "rawSql",
  builtin: true,
});

/** A Microsoft SQL Server query: `rawSql` is T-SQL with Grafana's macros. */
export const MSSQLQuery = makeQueryClass<"mssql", SqlQueryModel>({
  datasourceType: "mssql",
  className: "MSSQLQuery",
  description: "A Microsoft SQL Server query; rawSql is T-SQL with Grafana's macros",
  expressionField: "rawSql",
  builtin: true,
});

export type PromQueryEntity = InstanceType<typeof PromQuery>;
export type TempoQueryEntity = InstanceType<typeof TempoQuery>;
export type LokiQueryEntity = InstanceType<typeof LokiQuery>;
export type ElasticsearchQueryEntity = InstanceType<typeof ElasticsearchQuery>;
export type CloudWatchQueryEntity = InstanceType<typeof CloudWatchQuery>;
export type AzureMonitorQueryEntity = InstanceType<typeof AzureMonitorQuery>;
export type CloudMonitoringQueryEntity = InstanceType<typeof CloudMonitoringQuery>;
export type BigQueryQueryEntity = InstanceType<typeof BigQueryQuery>;
export type PyroscopeQueryEntity = InstanceType<typeof PyroscopeQuery>;
export type PostgresQueryEntity = InstanceType<typeof PostgresQuery>;
export type MySQLQueryEntity = InstanceType<typeof MySQLQuery>;
export type MSSQLQueryEntity = InstanceType<typeof MSSQLQuery>;
