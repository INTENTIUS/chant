import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";

/** The sql lexicon's AI skills, read from src/skills/. */
export const sqlSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-sql.md",
    name: "chant-sql",
    description:
      "Declare ClickHouse databases, tables, views and materialized views as SQL-shaped tagged templates, with references, lineage and the checks that run on them",
    triggers: [
      { type: "context" as const, value: "clickhouse" },
      { type: "context" as const, value: "clickhouse schema" },
      { type: "context" as const, value: "materialized view" },
    ],
    examples: [
      {
        title: "A table and a view that reads it",
        output:
          'export const analytics = database`CREATE DATABASE analytics ENGINE = Atomic`;\n' +
          "export const events = table`CREATE TABLE ${analytics}.events (user_id UUID, ts DateTime) ENGINE = MergeTree ORDER BY (user_id, ts)`;\n" +
          "export const recent = view`CREATE VIEW ${analytics}.recent AS SELECT ${events.columns.user_id} AS user_id FROM ${events}`;",
      },
    ],
  },
  {
    file: "chant-sql-plan.md",
    name: "chant-sql-plan",
    description:
      "Plan ClickHouse schema changes with chant sql diff and chant sql plan, and read the three change classes (metadata only, background rewrite, rebuild) with the ALTER restriction behind each",
    triggers: [
      { type: "context" as const, value: "clickhouse schema change" },
      { type: "context" as const, value: "sql plan" },
      { type: "context" as const, value: "alter table" },
    ],
    examples: [
      {
        title: "Classify a pull request's schema change offline",
        output: "chant sql diff base.json head.json",
      },
    ],
  },
  {
    file: "chant-sql-rebuild.md",
    name: "chant-sql-rebuild",
    description:
      "Run a ClickHouse table rebuild (a sorting key, primary key, partition key, engine or key column type change) with ClickHouseRebuildOp, a gated Op with backfill receipts, verification, an exchange swap and onFailure cleanup",
    triggers: [
      { type: "context" as const, value: "clickhouse rebuild" },
      { type: "context" as const, value: "change sorting key" },
      { type: "context" as const, value: "clickhouse migration" },
    ],
  },
  {
    file: "chant-sql-postgres.md",
    name: "chant-sql-postgres",
    description:
      "Declare Postgres schemas, tables, constraints, indexes, views, sequences, enum and domain types and extensions as SQL-shaped tagged templates, with references, lineage and the SQLPG lint rules",
    triggers: [
      { type: "context" as const, value: "postgres" },
      { type: "context" as const, value: "postgres schema" },
      { type: "context" as const, value: "postgresql" },
    ],
    examples: [
      {
        title: "A table with a foreign key and an index",
        output:
          'export const app = schema`CREATE SCHEMA app`;\n' +
          "export const users = table`CREATE TABLE ${app}.users (id bigint PRIMARY KEY)`;\n" +
          "export const orders = table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, user_id bigint NOT NULL REFERENCES ${users} (${users.columns.id}))`;\n" +
          "export const ordersUser = index`CREATE INDEX orders_user_id_idx ON ${orders} (${orders.columns.user_id})`;",
      },
    ],
  },
  {
    file: "chant-sql-postgres-plan.md",
    name: "chant-sql-postgres-plan",
    description:
      "Plan Postgres schema changes with chant sql diff and chant sql plan, and read the change classes (metadata only, validates, needs CONCURRENTLY, ACCESS EXCLUSIVE rewrite, expand and contract) as the lock each takes in production",
    triggers: [
      { type: "context" as const, value: "postgres schema change" },
      { type: "context" as const, value: "postgres lock" },
      { type: "context" as const, value: "postgres migration" },
    ],
    examples: [
      {
        title: "Classify a pull request's Postgres schema change offline",
        output: "chant sql diff base.json head.json",
      },
    ],
  },
  {
    file: "chant-sql-postgres-migration.md",
    name: "chant-sql-postgres-migration",
    description:
      "Run a Postgres column rename or type change with PostgresMigrationOp, a gated expand-and-contract Op with a dual-write trigger, a batched backfill with receipts, verification, a switch, replication lag handling and onFailure cleanup",
    triggers: [
      { type: "context" as const, value: "postgres column rename" },
      { type: "context" as const, value: "postgres expand and contract" },
      { type: "context" as const, value: "postgres backfill" },
    ],
  },
]);
