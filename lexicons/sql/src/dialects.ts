/**
 * The database dialects this lexicon declares, each at its own subpath
 * (`@intentius/chant-lexicon-sql/<dialect>`).
 *
 * A dialect is a database's own DDL, types and change rules, generated from
 * that database's catalog at a pinned version. There is no neutral schema
 * model between them: a Postgres table and a ClickHouse table are different
 * declarations, because the databases differ in ways a schema tool has to
 * respect (ClickHouse has no foreign keys and rebuilds a table to change its
 * sort key; Postgres has transactional DDL; MySQL commits each statement on
 * its own and holds a table's indexes in the table).
 */
export const SQL_DIALECTS = ["clickhouse", "postgres", "mysql"] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number];

/**
 * Dialects with generated types and nothing to declare them with. `sql.dialect`
 * refuses them with a message saying so, rather than as an unknown name. None
 * is planned now: MySQL (#5449) has its entities, planner and applier.
 */
export const PLANNED_SQL_DIALECTS: readonly string[] = [];
