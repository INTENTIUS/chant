/**
 * The MySQL entity types, apart from the entities so generation can name them
 * before the generated tables the entities read exist.
 */

export const MYSQL_ENTITY_TYPES = {
  database: "MySQL::Database",
  table: "MySQL::Table",
  view: "MySQL::View",
} as const;

export type MysqlEntityType = (typeof MYSQL_ENTITY_TYPES)[keyof typeof MYSQL_ENTITY_TYPES];
