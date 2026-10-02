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
title: "Planning and the Change Classifier"
description: "How a ClickHouse schema change is classified as metadata only, a background rewrite or a rebuild, each with the ALTER restriction behind it"
diataxis: reference
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
