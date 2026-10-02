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
      "Run a ClickHouse rebuild migration (a sorting key, partition key or engine change) as a gated Op with backfill receipts, verification, an exchange swap and onFailure cleanup; depends on the rebuild Op in #3198",
    triggers: [
      { type: "context" as const, value: "clickhouse rebuild" },
      { type: "context" as const, value: "change sorting key" },
      { type: "context" as const, value: "clickhouse migration" },
    ],
  },
]);
