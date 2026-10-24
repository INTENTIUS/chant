/**
 * `docs/pages/change-classifier.mdx`, written from the classifier's own rule
 * table by `npm run docs`, so the page cannot disagree with the rules.
 */

import { CLASSIFIER_RULES } from "../clickhouse/plan/rules";

const LABEL: Record<string, string> = {
  create: "create",
  drop: "drop",
  metadata: "metadata only",
  rewrite: "background rewrite",
  replace: "replace table",
  rebuild: "rebuild",
};

const cell = (s: string) => s.replace(/\|/g, "\\|");

export function renderClassifierPage(): string {
  const rows = Object.values(CLASSIFIER_RULES).map(
    (r) => `| ${r.id} | ${LABEL[r.class]} | ${cell(r.title)} | ${cell(r.restriction)} [ClickHouse docs](${r.cite}) |`,
  );
  return `---
title: "Planning ClickHouse Changes"
label: "Planning and the Change Classifier"
description: "How a ClickHouse schema change is classified as metadata only, a background rewrite, a replacement or a rebuild, each with the ALTER restriction behind it"
diataxis: reference
group: "ClickHouse"
order: 1
---

{/* Written by src/codegen/classifier-page.ts from src/clickhouse/plan/rules.ts. Edit the rules, then run npm run docs. */}

Every change between two ClickHouse schemas is classified before anything runs:

| Class | Means |
|---|---|
| metadata only | the server records the change and touches no existing data |
| background rewrite | a mutation rewrites existing parts in the background, with no rollback |
| replace table | ClickHouse cannot alter a stream-engine table, and it stores no rows, so the applier drops and creates it around the views that read it |
| rebuild | ClickHouse cannot make the change to the existing table, and the data has to be copied into a new one; a plan refuses to make it in place |

Two commands report the classification, and \`chant lifecycle plan\` reports it as each update's disruption (metadata only is \`in-place\`, a rewrite \`rolling\`, a replacement or a rebuild \`replace\`):

\`\`\`bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod schema.json        # a build output against the prod server
\`\`\`

Both exit 2 when a change needs a rebuild. \`chant sql diff\` compares a pull request's base and head builds with no server. \`chant sql plan\` reads the server \`sql.profiles.<env>\` binds, and asks that server's formatter about any expression the normalization rules leave different, so the server's own rewriting (\`INTERVAL 1 DAY\` as \`toIntervalDay(1)\`, \`a+b*2\` as \`a + (b * 2)\`) is not reported as a change.

\`chant sql plan\` also exits 2 when a declared database holds an object whose definition it cannot read. It names each one under \`Refused\` (\`unreadable\` in \`--json\`) instead of leaving it out. It exits 2 as well when the build names a named collection the server doesn't have, naming each under \`Refused\` (\`namedCollections.missing\` in \`--json\`); see [Named collections](../clickhouse-ddl/#named-collections). Dictionaries are read and planned like the other objects: any change but a comment replaces one (SQLCH245).

A clause chant's parser does not know ([Plain .sql Files](../sql-files/#clauses-chant-does-not-read)) is compared as text, and the rest of its object is planned as usual. A change to one is SQLCH290, refused for review with no rebuild Op suggested, since chant cannot tell what the change takes. A clause only the server prints is a hint, not a change: a newer server printing a clause with its default looks the same as a clause removed from the declaration.

## Stream tables

A table on Kafka, S3Queue, AzureQueue, RabbitMQ, NATS or FileLog stores no rows. It is the consumer that a materialized view reads through, and the position it has reached lives in the broker's committed offsets or in Keeper. There is no \`ALTER\` for its engine arguments, settings or columns, and there is nothing to copy, so a change to one is neither metadata nor a rebuild. It is SQLCH225, in the replace class (\`diffStreamTable\` in \`src/clickhouse/plan/diff.ts\`). The plan refuses nothing for it.

The applier makes the change in place, in this order (\`replaceStreamSteps\` in \`src/clickhouse/apply/statements.ts\`): \`DETACH TABLE\` for each materialized view on the server that reads the table, \`DROP TABLE ... SYNC\`, the declared \`CREATE TABLE\`, then \`ATTACH TABLE\` for the same views. The plan names the views in a hint. Messages wait in the broker, and files wait in the bucket, while the views are detached. A change that moves a table to or from a stream engine is still SQLCH223, a rebuild, and \`ClickHouseRebuildOp\` refuses a stream-engine table by name (\`streamRefusal\` in \`src/clickhouse/rebuild/observe.ts\`).

Two replacements lose the table's position, and the change carries a note saying so (\`positionWarnings\` in \`src/clickhouse/plan/stream.ts\`):

- A different \`kafka_group_name\`, as a setting or as the third engine argument, is a different consumer group. It starts from its own committed offsets, or from the start of the topic when it has none.
- A different S3Queue \`keeper_path\` is a different record of processed files. Every file already seen is processed again.

An apply killed between the detach and the attach leaves the views detached, and a detached view is not in \`system.tables\`. Nothing re-attaches it: run \`ATTACH TABLE\` for each view by hand, then plan again. This has not been run against a server.

The \`StreamIngest\` composite declares the stream table, the view and the MergeTree target together: see [Composites](../composites/#streamingest).

## After the plan

The plan only reports. [\`clickhouseApply\`](../applying/) makes the metadata-only, background-rewrite and stream-table changes, and refuses a rebuild the same way the plan does, sending nothing for that object. A rebuild runs as \`ClickHouseRebuildOp\`, a gated migration Op that creates the new table, backfills it, verifies it and swaps it in: see [Rebuilding a Table](../rebuild/). Both commands print the Op declaration to start from for each refused table.

\`chant migrate\` plays no part in any of this. It translates a file from one lexicon's format into another's, such as a GitHub Actions workflow into GitLab CI, and does not run schema migrations.

## Statements for a migration file

\`chant sql diff base.json head.json --statements\` prints the statements that take the base schema to the head one, offline: each one the applier would send for the same change, after a comment naming its object, rule and class. \`--json\` prints them as one document, which \`diffStatements(before, after)\` from \`@intentius/chant-lexicon-sql\` also returns:

\`\`\`sql
-- events (analytics.events): SQLCH201 metadata
ALTER TABLE \`analytics\`.\`events\` ADD COLUMN region String DEFAULT 'eu' AFTER \`user_id\`;

-- events (analytics.events): SQLCH210 rewrite, waits for its mutation
ALTER TABLE \`analytics\`.\`events\` MODIFY COLUMN \`kind\` LowCardinality(String);

-- sessions (analytics.sessions): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-analytics-sessions", env: "<env>", table: "analytics.sessions", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } });
\`\`\`

A rebuild is never DDL: it is a step naming \`ClickHouseRebuildOp\`, or for a view or a database, which the Op does not rebuild, a manual step. A column or object drop is a statement marked destructive. Each \`CREATE\` carries the project's ownership marker, as the applier stamps it. The command exits 2 when a step is not a statement. A migration runner's history table (\`schema_migrations\`, \`goose_db_version\`; see [Importing a Live Server](../importing/)) is never dropped: the report names it in a hint. Two things the applier asks the server are left out: whether a difference is formatting only, and whether a database is empty before it is dropped.

\`--topology\` renders the statements for where they will run: \`single\` (the default), \`cluster:<name>\`, \`replicated\` or \`cloud\`. On a cluster every statement carries \`ON CLUSTER\` and a MergeTree-family table becomes \`Replicated*MergeTree\` with its Keeper path; in a \`Replicated\` database the tables are \`Replicated*MergeTree\` with no path and no \`ON CLUSTER\`. \`diffStatements(before, after, { topology })\` takes the same choice; see [Applying to a Server](../applying/#topology).

## Migration files on a pull request

A workspace member that is a goose, golang-migrate, clickhouse-migrations or Flyway directory (see [Workspace kinds](/chant/reference/workspace-kinds/)) has no declaration to diff. On a pull request, \`chant components pr-plan\` lists each migration file the pull request adds to such a member, and the plan note gives every statement in it the class the rules below give the same change. This is the "check" level of adopting chant beside an existing migration tool: it reads files, applies nothing and contacts no server, so it needs no \`--env\`.

The up statements are the ones \`chant sql replay\` would run: goose's \`-- +goose Up\` section, the whole \`.up.sql\` file for golang-migrate, the whole file for clickhouse-migrations, and a Flyway file after placeholder substitution with the values in \`flyway.toml\` or \`flyway.conf\`. A file the base commit already has is not new, whatever the pull request does to it. Undo files are left out.

\`\`\`text
\`db/00002_orders.sql\` (member \`ledger\`, postgres)
- 1. \`CREATE INDEX orders_status_idx ON orders (status)\`: needs CONCURRENTLY (SQLPG241, SHARE)
- 2. \`ALTER TABLE orders ALTER COLUMN a TYPE bigint\`: undecided between SQLPG206 metadata only and SQLPG207 ACCESS EXCLUSIVE rewrite or scan
\`\`\`

Each statement is read with the dialect's parser (\`CREATE\`, \`GRANT\`, \`COMMENT ON\`) or word by word (\`ALTER\`, \`DROP\`, \`RENAME\`), and the lock on a Postgres statement is the one its rule's text names. The code is \`lexicons/sql/src/postgres/plan/statements.ts\` and \`lexicons/sql/src/clickhouse/plan/statements.ts\`.

A statement alone cannot always decide a rule, and then the note names the candidates and does not guess:

- \`ALTER COLUMN ... TYPE\` is SQLPG206 or SQLPG207 by the column's old type, and SQLPG208 as well with a \`USING\` expression.
- \`MODIFY COLUMN <type>\` is SQLCH210 or SQLCH211, \`DROP COLUMN\` SQLCH202 or SQLCH213, and \`RENAME COLUMN\` SQLCH212 or SQLCH213, by whether the column is in a key. When the same file creates the table, its keys are known and the statement is classified.
- \`MODIFY ORDER BY\` is SQLCH220, a rebuild. It is SQLCH216 or SQLCH220 when the same \`ALTER\` adds the columns the new key ends with, unless the file created the table and shows the old key is kept.
- \`CREATE OR REPLACE VIEW\` is SQLPG250 or SQLPG251 by whether the view keeps its columns.

A statement that reads or writes rows (\`INSERT\`, \`UPDATE\`, \`TRUNCATE\`) is listed as data. A schema change no rule covers, such as \`ALTER TABLE ... OWNER TO\` or a ClickHouse \`DROP PARTITION\`, is listed as having no class.

## Identity and renames

An object is identified by its export name between two builds, so a changed name in the SQL under the same export is a rename. Against a server, which has no export names, an object is identified by \`database.name\`; a declaration renamed since the server last saw it says so with \`-- previously: <old name>\` before its CREATE.

A column is identified by its name. A renamed column says so on its own line:

\`\`\`sql
CREATE TABLE events (
  event_kind LowCardinality(String), -- previously: kind
  ...
\`\`\`

Without the hint the change is a drop and an add, and the report points out a drop and an add with the same type in the same place.

## The rules

| Id | Class | Change | Restriction |
|---|---|---|---|
${rows.join("\n")}
`;
}
