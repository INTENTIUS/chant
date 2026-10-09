/**
 * `docs/pages/postgres-change-classifier.mdx`, written from the Postgres
 * classifier's own rule table by `npm run docs`, so the page cannot disagree
 * with the rules.
 */

import { PG_CHANGE_CLASSES, PG_CLASSIFIER_RULES } from "../postgres/plan/rules";

const cell = (s: string) => s.replace(/\|/g, "\\|");

export function renderPostgresClassifierPage(): string {
  const rows = Object.values(PG_CLASSIFIER_RULES).map(
    (r) => `| ${r.id} | ${PG_CHANGE_CLASSES.label[r.class]} | ${cell(r.title)} | ${cell(r.restriction)} [Postgres 18 docs](${r.cite}) |`,
  );
  return `---
title: "Postgres Locks and the Change Classifier"
label: "Locks and the Change Classifier"
description: "How a Postgres schema change is classified by the lock it takes and whether it reads or rewrites the table, each with the documentation behind it"
diataxis: reference
group: "Postgres"
order: 11
---

{/* Written by src/codegen/postgres-classifier-page.ts from src/postgres/plan/rules.ts. Edit the rules, then run npm run docs. */}

Every change between two Postgres schemas is classified before anything runs, by the lock it takes and whether it reads or rewrites the table, as the Postgres 18 reference states them. Where 14 to 17 differ, the rule says so.

| Class | Means | Disruption |
|---|---|---|
| create | a new object; nothing that exists changes | \`in-place\` |
| metadata only | a catalog change under a brief lock; no row is read or written | \`in-place\` |
| validates under a weaker lock | every row is read to check a constraint, under a lock weaker than ACCESS EXCLUSIVE | \`rolling\` |
| needs CONCURRENTLY | an index build or drop that blocks writes unless it is CONCURRENTLY, which cannot run in a transaction block | \`rolling\` |
| ACCESS EXCLUSIVE rewrite or scan | the table is rewritten or read in full while reads and writes wait | \`rolling\` |
| expand and contract | no in-place change keeps old readers working; a plan refuses it | \`replace\` |
| drop | the object, and a table's or sequence's data, is gone | \`destroy\` |

The disruption column is what \`chant lifecycle plan\` reports for each update. A changed path alone cannot always say which rule applies (a column's type, a constraint, a view's query, an enum's labels), and those report \`unknown\` there; \`chant sql plan\` has both definitions and classifies them.

\`\`\`bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod schema.json        # a build output against the prod server
\`\`\`

Both read the build's \`dialect\` and exit 2 when a change can only be made as expand and contract. \`--json\` prints the changes, the hints, the refused changes and the migration Op suggestions as one document. \`chant sql diff\` compares a pull request's base and head builds with no server. \`chant sql plan\` reads the server \`sql.profiles.<env>\` binds (else \`POSTGRES_URL\`), in the profile's \`schemas\` when it lists them, otherwise in the default schema and every schema the build declares an object in. Where the normalization rules leave an expression different, it asks that server: the declared view, or the table's column types, defaults, generated expressions and checks, are created as temporary objects in a transaction that is always rolled back, and read back with the same printers, so a view's \`SELECT *\` and the server's added parentheses are not reported as changes.

## Statements for a migration file

\`chant sql diff base.json head.json --statements\` prints the statements that take the base schema to the head one, offline: each one the applier would send for the same change, after a comment naming its object, rule and class, and whether it has to run outside a transaction block. \`--json\` prints them as one document, which \`diffStatements(before, after)\` from \`@intentius/chant-lexicon-sql\` also returns, each statement with \`transactional\` set:

\`\`\`sql
-- users (app.users): SQLPG201 metadata
ALTER TABLE app.users ADD COLUMN name text DEFAULT 'none' NOT NULL;

-- usersEmail (app.users_email_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email);

-- orders (app.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-app-orders-reference", env: "<env>", table: "app.orders", column: "reference" });
\`\`\`

A column rename or a type change across kinds is never DDL: it is a step naming \`PostgresMigrationOp\`, one per column. Any other expand-and-contract change, and the refused table's other changes, which the applier also holds back, are a manual step. A column or object drop is a statement marked destructive. Statements use the default schema for a bare name, as the applier sets \`search_path\`. The command exits 2 when a step is not a statement. What the applier asks the server is left out: its normalization of expressions the rules leave different, and an extension's own comment.

## Which major

Two rules change class across the supported majors: a STORED generated column's expression (SQLPG212) is a rewrite from 17 and expand and contract before it, and a table's access method (SQLPG226) is a rewrite from 15 and expand and contract before it.

- \`chant sql diff\` classifies for the major the builds recorded (\`postgresMajor\` in the build output): the newer build's, else the older build's, else \`sql.postgresMajor\`, else 18. A diff between two revisions does not depend on today's config.
- \`chant sql plan\` classifies for the major the server runs (\`server_version_num\`), since the server is what takes the locks. When the build targets another major, the plan says so in a hint.

## Identity and renames

An object is identified by its export name between two builds, and by its schema-qualified name against a server, which has no export names. Tables, views, materialized views, sequences and indexes share one namespace per schema, types and domains another, and schemas and extensions are matched by name.

A rename is declared where it happens. Before a CREATE, \`-- previously: <old name>\` says the object had another name; on a column's line, it says the column did:

\`\`\`sql
CREATE TABLE app.orders (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memo text   -- previously: note
)
\`\`\`

Without the hint, a column dropped and another added with the same type in the same place are reported as a drop and an add, with a hint asking whether it is a rename. A constraint left unnamed is matched by what it says, not by the name Postgres gave it, and an index on a table the same plan creates is part of the create.

An object another tool keeps is never proposed for a drop: an ORM's or migration runner's revision table with its sequence and indexes, and, with \`sql.provider\` set, the provider's own schemas and extensions. The plan names each in a hint and leaves it alone. Any other object in the schemas the plan reads that the build does not declare is a drop (SQLPG270); the applier drops it only when told to prune and only when it carries this project's marker.

## After the plan

The plan only reports. [\`postgresApply\`](../postgres-applying/) makes every change that is not expand and contract, grouping the statements into transactions by class and running \`CONCURRENTLY\` builds outside them. A column rename (SQLPG205) or a type change across kinds (SQLPG208) runs as \`PostgresMigrationOp\`, and both commands print the declaration to start from for each such column (\`migrationOps\` in \`--json\`): see [Migrating a Column](../postgres-migration/). The other expand-and-contract changes (a NOT NULL column with no default, a view losing or reordering columns, partitioning, a rename of a table, an enum label removed) have no Op yet and are made by hand.

## The rules

| Id | Class | Change | Restriction |
|---|---|---|---|
${rows.join("\n")}
`;
}
