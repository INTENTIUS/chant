/**
 * `docs/pages/object-coverage.mdx`, written from the coverage tables
 * (`../coverage/<dialect>.json`) by `npm run docs`, so the page cannot
 * disagree with what import refuses.
 */

import { KIND_COVERAGE, PINNED_COMMANDS, type KindRow } from "../coverage";
import type { SqlDialect } from "../dialects";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[{}<>]/g, (c) => `\\${c}`);

const STATUS: Record<KindRow["status"], string> = { declared: "declared", referenced: "referenced", refused: "refused", "out-of-scope": "out of scope" };

function table(dialect: SqlDialect): string {
  const rows = [...KIND_COVERAGE[dialect]].sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  return [
    "| Command | Kind | Status | Declared by, or why not |",
    "|---|---|---|---|",
    ...rows.map((r) => {
      const command = `\`${r.command}\`${r.form ? ` (${cell(r.form)})` : ""}`;
      const why = r.status === "declared" ? `\`${r.entity}\`${r.note ? `: ${cell(r.note)}` : ""}` : cell(r.reason ?? "");
      return `| ${command} | ${cell(r.kind)} | ${STATUS[r.status]} | ${why} |`;
    }),
  ].join("\n");
}

function counts(dialect: SqlDialect): string {
  const rows = KIND_COVERAGE[dialect];
  const n = (s: KindRow["status"]) => rows.filter((r) => r.status === s).length;
  const referenced = n("referenced") > 0 ? `, ${n("referenced")} referenced` : "";
  return `${n("declared")} declared${referenced}, ${n("refused")} refused, ${n("out-of-scope")} out of scope`;
}

export function renderCoveragePage(): string {
  const pg = PINNED_COMMANDS.postgres.map((p) => p.version).join(", ");
  const ch = PINNED_COMMANDS.clickhouse.map((p) => p.version).join(", ");
  return `---
title: "Object Coverage"
label: "Object Coverage"
description: "Every kind of object each pinned Postgres and ClickHouse server can create, marked declared, referenced, refused with a reason, or out of scope, and what import does with each"
diataxis: reference
order: 3
---

{/* Written by src/codegen/coverage-page.ts from src/coverage/postgres.json and src/coverage/clickhouse.json. Edit the tables, then run npm run docs. */}

Each row is a \`CREATE\` command a pinned server has, or one form of a command where chant treats the forms apart (\`CREATE TYPE ... AS ENUM\` is declared, \`CREATE TYPE ... AS RANGE\` is not). The commands come from the servers' own sources at each pinned version (\`scripts/sql-create-commands.ts\`), and a test fails when a pinned server has a command with no row here, so a new server release cannot add a kind nobody looked at.

- **declared**: a tag declares it, and import writes it as that declaration.
- **referenced**: the environment's, and never declared: a declaration names one, and chant never reads its values. A ClickHouse named collection is one ([#4395](https://github.com/INTENTIUS/chant/issues/4395)): \`ENGINE = S3(lake_creds, format = 'Parquet')\` names \`lake_creds\`, the build records the name, and \`chant sql plan\` fails when the server has no collection of that name. \`chant import --from <env>\` lists the server's SQL-defined collections as prerequisites and imports the rest. See [Named collections](../clickhouse-ddl/#named-collections).
- **refused**: no declaration holds it yet. \`chant import --from <env>\` fails when the server has one, naming every such object (kind, schema, name) at once, and \`chant import schema.sql\` fails on the statement. Nothing is left out without a word.
- **out of scope**: the environment's, not a schema's: import never reads it.

\`--skip-undeclarable\` (\`--parser-option skipUndeclarable\` for a file) imports everything else and lists the refused objects as warnings, for an adopter who keeps those objects by hand for now:

\`\`\`bash
chant import --from prod --skip-undeclarable
chant import schema.sql --parser-option skipUndeclarable
\`\`\`

What a managed provider, an extension or the server's configuration files define is never refused: an extension's aggregates and casts are the extension's, declared with it, and a quota from \`users.xml\` is the server's. An import with \`--type\`, \`--name\` or \`--owned\` asks only for objects chant can hold, and does not look for the rest.

## Postgres

Pinned majors: ${pg}. ${counts("postgres")}.

${table("postgres")}

## ClickHouse

Pinned release: ${ch}. ${counts("clickhouse")}.

${table("clickhouse")}

## Declaring a refused kind

A kind becomes declarable in three steps: a tag that declares it, the catalog reader reading it (\`src/postgres/live/catalog.ts\`, \`src/clickhouse/live/catalog.ts\`), and its row flipped to \`declared\` with the entity type, its reason taken out. The row's flip is what stops import refusing the kind. After moving a pin, run \`npx tsx scripts/sql-create-commands.ts\` and give each new command a row.
`;
}
