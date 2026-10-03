/**
 * Documentation generation for the sql lexicon: the generated reference pages
 * from the core docs pipeline, plus the authored pages in docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";
import { renderClassifierPage } from "./classifier-page";
import { renderPostgresClassifierPage } from "./postgres-classifier-page";

const overview = `The sql lexicon declares database schema in TypeScript. It has two dialects,
each a subpath of the one package: ClickHouse at
\`@intentius/chant-lexicon-sql/clickhouse\` and Postgres at
\`@intentius/chant-lexicon-sql/postgres\`. A declaration is the database's own
\`CREATE\` statement in a tagged template, and an interpolated object or
column stays a reference. The package is not on npm yet; each dialect's
Getting Started page runs it from a checkout of the chant repository.

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
\`\`\`

\`\`\`ts
import { schema, table, index } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema\`CREATE SCHEMA app\`;

export const users = table\`
  CREATE TABLE \${app}.users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE
  )\`;

export const usersEmail = index\`
  CREATE INDEX CONCURRENTLY users_email_lower_idx ON \${users} (lower(\${users.columns.email}))\`;
\`\`\`

## Spec-true per dialect

Each dialect is true to its own database. For SQL the spec is the database's
own DDL, so a ClickHouse declaration is a ClickHouse \`CREATE\` statement and a
Postgres declaration a Postgres one. The names a declaration can use (engines,
codecs and settings for ClickHouse; types, access methods, storage parameters
and extensions for Postgres) are generated from a pinned server's own catalog:
ClickHouse's \`system.*\` tables, and Postgres's \`pg_catalog\` at one pinned
release of each supported major. There is no neutral schema model that the
dialects are translated from.

The reason is that the databases differ exactly where a schema tool does its
work. ClickHouse has no foreign keys and no transactional DDL, and it cannot
change a table's sort key, partition key or engine in place: the rows have to
be copied into a new table. Postgres makes most changes in place and inside a
transaction, and what a change costs there is the lock it takes: adding a
column with a constant default is a catalog change, a type change that
rewrites the table blocks every reader until it finishes, and an index built
without \`CONCURRENTLY\` blocks every writer. A neutral model would have to hide
those differences, so a plan could not say what a change will cost, or carry
every dialect's features and check each one against the target anyway.

So each dialect has its own types, parser, lint rules and post-synth checks,
change classifier, applier, migration Op, composites and skills. What the two
share is the way of working:

| | ClickHouse | Postgres |
|---|---|---|
| Declaring | \`database\`, \`table\`, \`view\` | \`schema\`, \`table\`, \`index\`, \`view\`, \`sequence\`, \`type\`, \`domain\`, \`extension\` |
| Types from | one pinned \`clickhouse-server\` release | one pinned \`postgres\` release per major, 14 to 18 |
| Rule ids | SQLCH001-003, SQLCH101-120, SQLCH200-250 | SQLPG001-004, SQLPG101-118, SQLPG200-270 |
| Change classes | metadata only, background rewrite, rebuild | metadata only, validates under a weaker lock, needs \`CONCURRENTLY\`, \`ACCESS EXCLUSIVE\` rewrite or scan, expand and contract |
| Applier (\`ApplyOp\` target) | \`clickhouseApply\` (\`clickhouse\`) | \`postgresApply\` (\`postgres\`) |
| What a plan refuses runs as | \`ClickHouseRebuildOp\` | \`PostgresMigrationOp\` |
| Ownership marker | a trailer on the object's comment | a trailer on the object's comment |

References, dependency order and column lineage work the same way in both, as
do \`chant sql diff\` and \`chant sql plan\` (they read the build's
\`dialect\`), import with \`chant import --from <env>\`, the \`-- previously:\`
rename hint, and the comment trailer that marks what chant owns.

One build holds one dialect. A project that declares both ClickHouse and
Postgres objects fails the build naming one of each; a Postgres database and
a ClickHouse database are two projects, which a workspace can hold as two
members. \`sql.dialect\` in \`chant.config.ts\` says which dialect a project is
when nothing declared says so, as for an import into an empty project.

## Pages

ClickHouse:

- [Getting Started with ClickHouse](./getting-started/): declare a schema,
  build it, apply it to a local server and plan a change against it.
- [Declaring ClickHouse Tables and Views](./clickhouse-ddl/): databases,
  tables, views and materialized views, and what each kind of interpolation
  means.
- [Importing a ClickHouse Server](./importing/): \`chant import --from <env>\`
  from \`SHOW CREATE\`.
- [Planning and the Change Classifier](./change-classifier/): every change
  classified as metadata only, a background rewrite or a rebuild.
- [Applying to a ClickHouse Server](./applying/): \`clickhouseApply\`, the
  ownership marker, prune and the local server.
- [Rebuilding a Table](./rebuild/): \`ClickHouseRebuildOp\` for the changes
  ClickHouse cannot make in place.
- [Where the ClickHouse Types Come From](./clickhouse-catalog/): the pinned
  server and how to move the pin.

Postgres:

- [Getting Started with Postgres](./postgres-getting-started/): declare a
  schema, apply it to a local server, add a column and an index, and see a
  rename refused.
- [Declaring Postgres Objects](./postgres-ddl/): the eight tags,
  constraints, \`nextval(\${seq})\`, \`COMMENT ON\` and \`literal()\`.
- [Importing a Postgres Server](./postgres-importing/): canonical text from
  the catalog's printers, and the objects that belong to someone else.
- [Postgres Locks and the Change Classifier](./postgres-change-classifier/):
  every change classified by the lock it takes.
- [Applying to a Postgres Server](./postgres-applying/): transactions,
  \`CONCURRENTLY\`, timeouts, ownership, prune and the local server.
- [Migrating a Column](./postgres-migration/): \`PostgresMigrationOp\`, the
  expand-and-contract Op for a column rename or type change.
- [Managed Providers](./postgres-providers/): \`sql.provider\`, SQLPG004, and
  what each provider's data has not verified.
- [The Postgres Pin and Supported Majors](./postgres-majors/): one pin per
  major, \`sql.postgresMajor\`, and moving a pin.

Both dialects:

- [References and Lineage](./references-and-lineage/): how references become
  dependency order and column-level lineage.
- [Composites](./composites/): five ClickHouse and five Postgres composites.
- [Lint Rules and Checks](./lint-rules/): every lint rule and post-synth
  check.

## Schema changes and \`chant migrate\`

\`chant migrate\` translates a file from one lexicon's format into another's,
such as a GitHub Actions workflow into GitLab CI. It does not run schema
migrations, and the sql lexicon registers nothing for it. A schema change is a
change to the declarations: \`chant sql diff\` or \`chant sql plan\` classifies
it, the dialect's applier makes the changes it can make in place, and a change
it cannot make runs as a gated migration Op: \`ClickHouseRebuildOp\` (see
[Rebuilding a Table](./rebuild/)) or \`PostgresMigrationOp\` (see
[Migrating a Column](./postgres-migration/)).
`;

const outputFormat = `A build writes two files, beside each other. Which pair depends on the
dialect the project declares.

- The primary output (the \`-o\` file, \`dist/schema.json\` by convention), one
  JSON document. \`dialect\` is \`clickhouse\` or \`postgres\`. \`applyOrder\`
  lists the export names in the order the objects have to be created.
  \`objects\` holds one entry per declared object, in that order: its export
  name (\`export\`), its type, its SQL name (\`sqlName\`), its parsed
  definition, \`dependsOn\`, and its \`ddl\`. References are written as export
  names and lineage as \`export.column\`.
  - ClickHouse: the types are \`ClickHouse::Database\`, \`::Table\`, \`::View\`
    and \`::MaterializedView\`, and the definition holds columns, engine, keys,
    TTL, settings, indexes, projections and constraints, and for a view its
    \`select\`, \`reads\`, \`to\` and \`lineage\`.
  - Postgres: the document also carries \`postgresMajor\`, the major the
    project targets (\`sql.postgresMajor\`, else 18, the newest pinned). The
    types are \`Postgres::Schema\`, \`::Table\`, \`::Index\`, \`::View\`,
    \`::MaterializedView\`, \`::Sequence\`, \`::Enum\`, \`::Domain\` and
    \`::Extension\`. A table's definition holds its columns, primary key,
    uniques, checks, foreign keys, exclusions and the rest of its clauses; a
    view's its \`query\`, \`reads\` and \`lineage\`; an index's its table,
    method and elements. \`dependsOn\` names the objects and the columns the
    statement references.
- \`clickhouse.sql\` or \`postgres.sql\`: every statement in \`applyOrder\`, each
  ending in \`;\`, written byte for byte as declared, with a Postgres
  template's \`COMMENT ON\` statements after its \`CREATE\`.

The order follows the references: a table after its database or schema and the
types and sequences it uses, a view after the tables it reads, an index after
its table, a materialized view after its \`TO\` target. Ties go by export name,
so the output does not depend on the order files were found in. A reference
cycle fails the build and names the cycle.

\`chant sql diff\`, \`chant sql plan\`, the post-synth checks and the appliers
read the JSON document. Neither file carries chant's ownership marker: the
applier adds it to each object's comment when it creates the object (see
[Applying to a ClickHouse Server](../applying/) and
[Applying to a Postgres Server](../postgres-applying/)).
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  writeFileSync(join(pkgDir, "docs", "pages", "change-classifier.mdx"), renderClassifierPage());
  writeFileSync(join(pkgDir, "docs", "pages", "postgres-change-classifier.mdx"), renderPostgresClassifierPage());

  const config: DocsConfig = {
    name: "sql",
    displayName: "SQL",
    description: "Database schema as typed declarations in each database's own DDL: ClickHouse and Postgres",
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
