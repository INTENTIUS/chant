/**
 * Documentation generation for the sql lexicon: the generated reference pages
 * from the core docs pipeline, plus the authored pages in docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";
import { renderClassifierPage } from "./classifier-page";

const overview = `The sql lexicon declares database schema in TypeScript, one database dialect
at a time. ClickHouse is the first dialect, at
\`@intentius/chant-lexicon-sql/clickhouse\`. The package is not on npm yet;
[Getting Started](./getting-started/) runs it from a checkout of the chant
repository.

\`\`\`ts
import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const analytics = database\`CREATE DATABASE analytics ENGINE = Atomic\`;

export const events = table\`
  CREATE TABLE \${analytics}.events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (user_id, kind, ts)\`;

export const byKind = view\`
  CREATE VIEW \${analytics}.by_kind AS
  SELECT \${events.columns.kind} AS kind, count() AS n
  FROM \${events}
  GROUP BY kind\`;
\`\`\`

## Spec-true per dialect

chant is spec-true per dialect, not database-agnostic. For SQL the spec is
the database's own DDL, so a ClickHouse declaration is a ClickHouse
\`CREATE\` statement, and the engines, column types, codecs and settings it can
name are the ones a pinned ClickHouse server lists in its \`system.*\` tables.
There is no neutral schema model that each dialect is translated from.

The reason is that databases differ exactly where a schema tool does its
work. ClickHouse has no foreign keys and no transactional DDL, and it cannot
change a table's sort key, partition key or engine in place: the rows have to
be copied into a new table. Postgres makes most of those changes in place,
inside a transaction. A neutral model would have to hide those differences, so
a plan could not say what a change will cost, or carry every dialect's
features and check each one against the target anyway. So each dialect has its
own types, parser, lint rules, change classifier and applier. What stays the
same from one dialect to the next is the way you work: the tagged-template
form, references and lineage, the three change classes, plan, apply, and Ops
for what a plan cannot do in place.

## Pages

- [Getting Started](./getting-started/): declare a schema, build it, apply it
  to a local server and plan a change against it.
- [Declaring Tables and Views](./clickhouse-ddl/): databases, tables, views and
  materialized views as tagged templates, and what each kind of interpolation
  means.
- [References and Lineage](./references-and-lineage/): how references become
  dependency order and column-level lineage.
- [Importing a Live Server](./importing/): \`chant import --from <env>\` writes
  a running server's schema as declarations.
- [Planning and the Change Classifier](./change-classifier/): every change
  classified as metadata only, a background rewrite or a rebuild, each with the
  ClickHouse \`ALTER\` restriction behind it.
- [Applying to a Server](./applying/): \`clickhouseApply\`, chant's ownership
  marker on the object's comment, and the local server \`chant emulator\` starts.
- [Rebuilding a Table](./rebuild/): \`ClickHouseRebuildOp\` for the changes
  ClickHouse cannot make in place: a new table filled, verified and swapped in.
- [Composites](./composites/): \`ReplacingTable\`, \`EventsTable\`,
  \`RollupView\`, \`CdcMirror\` and \`ShardedTable\`.
- [Lint Rules and Checks](./lint-rules/): every SQLCH lint rule and post-synth
  check.
- [Where the Types Come From](./clickhouse-catalog/): the pinned server, the
  committed catalog snapshot, and how to move the pin.

## Schema changes and \`chant migrate\`

\`chant migrate\` translates a file from one lexicon's format into another's,
such as a GitHub Actions workflow into GitLab CI. It does not run schema
migrations, and the sql lexicon registers nothing for it. A schema change is a
change to the declarations: \`chant sql diff\` or \`chant sql plan\` classifies
it, \`clickhouseApply\` makes the metadata-only and background-rewrite changes,
and a change that needs a rebuild runs as \`ClickHouseRebuildOp\`, a gated
migration Op: see [Rebuilding a Table](./rebuild/).
`;

const outputFormat = `A build writes two files, beside each other:

- The primary output (the \`-o\` file, \`dist/schema.json\` by convention), one
  JSON document. \`dialect\` is \`clickhouse\`. \`applyOrder\` lists the export
  names in the order the objects have to be created. \`objects\` holds one entry
  per declared object, in that order: its export name (\`export\`), its type
  (\`ClickHouse::Database\`, \`::Table\`, \`::View\` or \`::MaterializedView\`), its
  SQL name (\`sqlName\`), its parsed definition (columns, engine, keys, TTL,
  settings, indexes, projections and constraints, and for a view its
  \`select\`, \`reads\`, \`to\` and \`lineage\`), \`dependsOn\`, and its \`ddl\`.
  References are written as export names and lineage as \`export.column\`.
- \`clickhouse.sql\`: every statement in \`applyOrder\`, each ending in \`;\`,
  written byte for byte as declared.

The order follows the references: a table after its database, a view after the
tables it reads, a materialized view after its \`TO\` target. Ties go by export
name, so the output does not depend on the order files were found in. A
reference cycle fails the build and names the cycle.

\`chant sql diff\`, \`chant sql plan\`, the post-synth checks and
\`clickhouseApply\` read the JSON document. Neither file carries chant's
ownership marker: the applier adds it to each object's comment when it creates
the object (see [Applying to a Server](../applying/)).
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  writeFileSync(join(pkgDir, "docs", "pages", "change-classifier.mdx"), renderClassifierPage());

  const config: DocsConfig = {
    name: "sql",
    displayName: "SQL",
    description: "Database schema as typed declarations, one dialect at a time; ClickHouse first",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/sql/",
    overview,
    outputFormat,
    serviceFromType: (type) => type.split("::")[0] ?? "SQL",
    srcDir: join(pkgDir, "src"),
    examplesDir: join(pkgDir, "examples"),
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
