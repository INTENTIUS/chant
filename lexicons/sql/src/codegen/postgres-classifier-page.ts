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
description: "How a Postgres schema change is classified by the lock it takes and whether it reads or rewrites the table, each with the documentation behind it"
diataxis: reference
order: 6
---

{/* Written by src/codegen/postgres-classifier-page.ts from src/postgres/plan/rules.ts. Edit the rules, then run npm run docs. */}

Every change between two Postgres schemas is classified before anything runs, by the lock it takes and whether it reads or rewrites the table, as the Postgres 18 reference states them (the pinned major; where 14 to 17 differ, the rule says so):

| Class | Means |
|---|---|
| metadata only | a catalog change under a brief lock; no row is read or written |
| validates under a weaker lock | every row is read to check a constraint, under a lock weaker than ACCESS EXCLUSIVE |
| needs CONCURRENTLY | an index build that blocks writes unless it is CONCURRENTLY, which cannot run in a transaction block |
| ACCESS EXCLUSIVE rewrite or scan | the table is rewritten or read in full while reads and writes wait |
| expand and contract | no in-place change keeps old readers working; a plan refuses it |

\`\`\`bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod schema.json        # a build output against the prod server
\`\`\`

Both exit 2 when a change can only be made as expand and contract. \`chant sql plan\` reads the server \`sql.profiles.<env>\` binds, and asks it about any expression the normalization rules leave different, by creating the declared view or the table's expressions as temporary objects in a transaction it always rolls back.

An object is identified by its export name between two builds and by its qualified name against a server; \`-- previously: <old name>\` before a CREATE, or on a column's line, declares a rename. A constraint left unnamed is matched by what it says.

## The rules

| Id | Class | Change | Restriction |
|---|---|---|---|
${rows.join("\n")}
`;
}
