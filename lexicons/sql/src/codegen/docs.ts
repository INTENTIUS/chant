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
\`@intentius/chant-lexicon-sql/clickhouse\`.

chant is spec-true per dialect, not database-agnostic. Each dialect's engines,
column types, codecs and settings are that database's own, read from a pinned
server, because databases differ in ways a schema tool has to respect:
ClickHouse has no foreign keys and rebuilds a table to change its sort key,
where Postgres changes most things in place inside a transaction.

Tables, views, materialized views and databases are declared as their own
DDL in tagged templates, parsed at build time into entities with references,
dependency order and column lineage: see
[Declaring Tables and Views](./clickhouse-ddl/). The types come from a pinned
server's catalog: see [Where the Types Come From](./clickhouse-catalog/).

\`chant import --from <env>\` writes a live server's schema as declarations:
see [Importing a Live Server](./importing/). Every schema change is
classified as metadata only, a background rewrite or a rebuild, each with the
ClickHouse \`ALTER\` restriction behind it, and a rebuild is refused in place:
see [Planning and the Change Classifier](./change-classifier/). A rebuild runs
as \`ClickHouseRebuildOp\`, a gated Op that fills a new table, verifies it and
swaps it in: see [Rebuilding a Table](./rebuild/).
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
    serviceFromType: (type) => type.split("::")[0] ?? "SQL",
    srcDir: join(pkgDir, "src"),
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
