/**
 * The entity registry, `lexicon-sql.json`: one entry per entity kind, which the
 * LSP completes and hovers from and `dist/meta.json` packages.
 *
 * The entities are hand-written: their shape is the DDL a tag parses, not a
 * schema document. Each is keyed by the kind's name and points at the entity
 * type the tag gives it. ClickHouse's kinds came first and keep their bare
 * names; Postgres's carry the dialect in the name, since both have a table
 * and a view.
 */

import { CLICKHOUSE_ENTITY_TYPES } from "../clickhouse/entities";
import { POSTGRES_ENTITY_TYPES } from "../postgres/entity-types";

const KINDS: Record<string, string> = {
  Database: CLICKHOUSE_ENTITY_TYPES.database,
  Table: CLICKHOUSE_ENTITY_TYPES.table,
  View: CLICKHOUSE_ENTITY_TYPES.view,
  MaterializedView: CLICKHOUSE_ENTITY_TYPES.materializedView,
  Dictionary: CLICKHOUSE_ENTITY_TYPES.dictionary,
  Function: CLICKHOUSE_ENTITY_TYPES.function,
  User: CLICKHOUSE_ENTITY_TYPES.user,
  Role: CLICKHOUSE_ENTITY_TYPES.role,
  RowPolicy: CLICKHOUSE_ENTITY_TYPES.rowPolicy,
  Grant: CLICKHOUSE_ENTITY_TYPES.grant,
  Quota: CLICKHOUSE_ENTITY_TYPES.quota,
  SettingsProfile: CLICKHOUSE_ENTITY_TYPES.settingsProfile,
  PostgresSchema: POSTGRES_ENTITY_TYPES.schema,
  PostgresTable: POSTGRES_ENTITY_TYPES.table,
  PostgresIndex: POSTGRES_ENTITY_TYPES.index,
  PostgresView: POSTGRES_ENTITY_TYPES.view,
  PostgresMaterializedView: POSTGRES_ENTITY_TYPES.materializedView,
  PostgresSequence: POSTGRES_ENTITY_TYPES.sequence,
  PostgresEnum: POSTGRES_ENTITY_TYPES.enum,
  PostgresCompositeType: POSTGRES_ENTITY_TYPES.composite,
  PostgresRangeType: POSTGRES_ENTITY_TYPES.range,
  PostgresDomain: POSTGRES_ENTITY_TYPES.domain,
  PostgresAggregate: POSTGRES_ENTITY_TYPES.aggregate,
  PostgresCollation: POSTGRES_ENTITY_TYPES.collation,
  PostgresCast: POSTGRES_ENTITY_TYPES.cast,
  PostgresEventTrigger: POSTGRES_ENTITY_TYPES.eventTrigger,
  PostgresOperator: POSTGRES_ENTITY_TYPES.operator,
  PostgresOperatorClass: POSTGRES_ENTITY_TYPES.operatorClass,
  PostgresOperatorFamily: POSTGRES_ENTITY_TYPES.operatorFamily,
  PostgresForeignTable: POSTGRES_ENTITY_TYPES.foreignTable,
  PostgresTextSearchConfiguration: POSTGRES_ENTITY_TYPES.textSearchConfiguration,
  PostgresTextSearchDictionary: POSTGRES_ENTITY_TYPES.textSearchDictionary,
  PostgresStatistics: POSTGRES_ENTITY_TYPES.statistics,
  PostgresForeignDataWrapper: POSTGRES_ENTITY_TYPES.foreignDataWrapper,
  PostgresForeignServer: POSTGRES_ENTITY_TYPES.foreignServer,
  PostgresPublication: POSTGRES_ENTITY_TYPES.publication,
  PostgresExtension: POSTGRES_ENTITY_TYPES.extension,
  PostgresFunction: POSTGRES_ENTITY_TYPES.function,
  PostgresProcedure: POSTGRES_ENTITY_TYPES.procedure,
  PostgresTrigger: POSTGRES_ENTITY_TYPES.trigger,
  PostgresPolicy: POSTGRES_ENTITY_TYPES.policy,
  PostgresRole: POSTGRES_ENTITY_TYPES.role,
  PostgresGrant: POSTGRES_ENTITY_TYPES.grant,
  PostgresDefaultPrivileges: POSTGRES_ENTITY_TYPES.defaultPrivileges,
};

export function buildRegistry(): string {
  const registry = Object.fromEntries(
    Object.entries(KINDS).map(([name, resourceType]) => [name, { resourceType, kind: "resource", lexicon: "sql" }]),
  );
  return `${JSON.stringify(registry, null, 2)}\n`;
}
