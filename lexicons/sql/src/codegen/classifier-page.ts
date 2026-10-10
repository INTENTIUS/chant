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
description: "How a ClickHouse schema change is classified as metadata only, a background rewrite or a rebuild, each with the ALTER restriction behind it"
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
| rebuild | ClickHouse cannot make the change to the existing table, and the data has to be copied into a new one; a plan refuses to make it in place |

Two commands report the classification, and \`chant lifecycle plan\` reports it as each update's disruption (metadata only is \`in-place\`, a rewrite \`rolling\`, a rebuild \`replace\`):

\`\`\`bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod schema.json        # a build output against the prod server
\`\`\`

Both exit 2 when a change needs a rebuild. \`chant sql diff\` compares a pull request's base and head builds with no server. \`chant sql plan\` reads the server \`sql.profiles.<env>\` binds, and asks that server's formatter about any expression the normalization rules leave different, so the server's own rewriting (\`INTERVAL 1 DAY\` as \`toIntervalDay(1)\`, \`a+b*2\` as \`a + (b * 2)\`) is not reported as a change.

\`chant sql plan\` also exits 2 when a declared database holds an object chant cannot read yet, a dictionary. It names each one under \`Refused\` (\`unreadable\` in \`--json\`) instead of leaving it out, and \`chant lifecycle diff --live\` reports each one as unobserved. A table with the \`Dictionary\` engine is a table, and is read.

## After the plan

The plan only reports. [\`clickhouseApply\`](../applying/) makes the metadata-only and background-rewrite changes, and refuses a rebuild the same way the plan does, sending nothing for that object. A rebuild runs as \`ClickHouseRebuildOp\`, a gated migration Op that creates the new table, backfills it, verifies it and swaps it in: see [Rebuilding a Table](../rebuild/). Both commands print the Op declaration to start from for each refused table.

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

A rebuild is never DDL: it is a step naming \`ClickHouseRebuildOp\`, or for a view or a database, which the Op does not rebuild, a manual step. A column or object drop is a statement marked destructive. Each \`CREATE\` carries the project's ownership marker, as the applier stamps it. The command exits 2 when a step is not a statement. Two things the applier asks the server are left out: whether a difference is formatting only, and whether a database is empty before it is dropped.

\`--topology\` renders the statements for where they will run: \`single\` (the default), \`cluster:<name>\`, \`replicated\` or \`cloud\`. On a cluster every statement carries \`ON CLUSTER\` and a MergeTree-family table becomes \`Replicated*MergeTree\` with its Keeper path; in a \`Replicated\` database the tables are \`Replicated*MergeTree\` with no path and no \`ON CLUSTER\`. \`diffStatements(before, after, { topology })\` takes the same choice; see [Applying to a Server](../applying/#topology).

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
