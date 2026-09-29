/**
 * Hand-written query models for the datasources that have no schema.
 *
 * PostgreSQL, MySQL and Microsoft SQL Server share one query model, defined
 * in TypeScript in Grafana's `@grafana/sql` package with no CUE kind, so
 * foundation-sdk publishes no JSON Schema for it and `npm run generate` has
 * nothing to read. The types here follow `packages/grafana-sql/src` at
 * Grafana v13.2.2, cited per type. The three plugins bundled with
 * grafana/grafana:13.2.2 (grafana-postgresql-datasource 13.0.3, mysql 13.1.2,
 * mssql 13.0.5) use this model unchanged. GRAF107 does not check these
 * queries' fields; the dashboard schema's `Panel` still checks the panel.
 */

/** `QueryEditorExpressionType`, packages/grafana-sql/src/expressions.ts:34-42. */
export type SqlExpressionType = "property" | "operator" | "or" | "and" | "groupBy" | "function" | "functionParameter";

/** `QueryEditorProperty`, packages/grafana-sql/src/expressions.ts:5-8 (its type is the one-member `QueryEditorPropertyType`). */
export interface SqlProperty {
  type: "string";
  name?: string;
}

/** `QueryEditorFunctionParameterExpression`, packages/grafana-sql/src/expressions.ts:64-67. */
export interface SqlFunctionParameterExpression {
  type: "functionParameter";
  name?: string;
}

/** `QueryEditorFunctionExpression`, packages/grafana-sql/src/expressions.ts:57-62: a selected column, optionally wrapped in an aggregation. */
export interface SqlFunctionExpression {
  type: "function";
  name?: string;
  alias?: string;
  parameters?: SqlFunctionParameterExpression[];
}

/** `QueryEditorGroupByExpression`, packages/grafana-sql/src/expressions.ts:52-55. */
export interface SqlGroupByExpression {
  type: "groupBy";
  property: SqlProperty;
}

/** `QueryEditorPropertyExpression`, packages/grafana-sql/src/expressions.ts:29-32. */
export interface SqlPropertyExpression {
  type: "property";
  property: SqlProperty;
}

/**
 * The visual builder's query: `SQLExpression`, packages/grafana-sql/src/types.ts:67-77.
 * `whereJsonTree` is react-awesome-query-builder's `JsonTree`, carried as data.
 */
export interface SqlExpression {
  columns?: SqlFunctionExpression[];
  whereJsonTree?: Record<string, unknown>;
  whereString?: string;
  filters?: Array<{ name: string; value: string }>;
  groupBy?: SqlGroupByExpression[];
  orderBy?: SqlPropertyExpression;
  orderByDirection?: "ASC" | "DESC";
  limit?: number;
  offset?: number;
}

/** `QueryFormat`, packages/grafana-sql/src/types.ts:39-42. */
export type SqlQueryFormat = "time_series" | "table";

/**
 * A PostgreSQL, MySQL or MSSQL query: `SQLQuery`, packages/grafana-sql/src/types.ts:46-56,
 * over `DataQuery` from @grafana/schema (refId, hide, key, queryType, datasource).
 *
 * In code mode (`editorMode: "code"`, `rawQuery: true`) `rawSql` is the
 * query; in builder mode `dataset`, `table` and `sql` describe it and Grafana
 * writes the generated SQL to `rawSql`.
 */
export interface SqlQueryModel {
  refId?: string;
  hide?: boolean;
  key?: string;
  queryType?: string;
  datasource?: { type?: string; uid?: string };
  /** The SQL, with Grafana's `$__timeFilter()` and other macros. */
  rawSql?: string;
  format?: SqlQueryFormat;
  alias?: string;
  dataset?: string;
  table?: string;
  sql?: SqlExpression;
  /** `EditorMode` from @grafana/plugin-ui: the raw SQL editor or the visual builder. */
  editorMode?: "code" | "builder";
  rawQuery?: boolean;
  /** `SQLQueryMeta`, packages/grafana-sql/src/types.ts:44: which columns a variable query takes its values and texts from. */
  meta?: { valueField?: string; textField?: string };
}
