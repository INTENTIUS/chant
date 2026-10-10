/**
 * Tables another tool keeps its migration history in, by name, with the tool.
 *
 * Both dialects' catalog readers mark a table by one of these names as
 * foreign: import leaves it out with a warning, and a plan names it in a hint
 * instead of proposing a drop, since chant changing it would change what that
 * tool owns (#3047 question 10, #3676). golang-migrate, dbmate, goose and
 * Flyway keep the same tables on ClickHouse as on Postgres.
 */
export const FOREIGN_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations: "Prisma Migrate",
  schema_migrations: "a migration runner (Rails, golang-migrate, dbmate)",
  ar_internal_metadata: "Rails",
  django_migrations: "Django",
  alembic_version: "Alembic",
  __drizzle_migrations: "drizzle-kit",
  flyway_schema_history: "Flyway",
  goose_db_version: "goose",
  knex_migrations: "Knex",
  knex_migrations_lock: "Knex",
  SequelizeMeta: "Sequelize",
  pgmigrations: "node-pg-migrate",
};

/** The tool that keeps a table by this name, or undefined when none does. */
export function foreignTool(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FOREIGN_TABLES, name) ? FOREIGN_TABLES[name] : undefined;
}
