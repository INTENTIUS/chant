/**
 * The Postgres entity types, apart from the tags so generation can name them
 * before the generated tables the tags read exist.
 */

export const POSTGRES_ENTITY_TYPES = {
  schema: "Postgres::Schema",
  table: "Postgres::Table",
  index: "Postgres::Index",
  view: "Postgres::View",
  materializedView: "Postgres::MaterializedView",
  sequence: "Postgres::Sequence",
  enum: "Postgres::Enum",
  domain: "Postgres::Domain",
  extension: "Postgres::Extension",
} as const;

export type PostgresEntityType = (typeof POSTGRES_ENTITY_TYPES)[keyof typeof POSTGRES_ENTITY_TYPES];
