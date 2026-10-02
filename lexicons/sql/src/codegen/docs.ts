/**
 * Documentation generation for the sql lexicon: the generated reference pages
 * from the core docs pipeline, plus the authored pages in docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `The sql lexicon declares database schema in TypeScript, one database dialect
at a time. ClickHouse is the first dialect, at
\`@intentius/chant-lexicon-sql/clickhouse\`.

chant is spec-true per dialect, not database-agnostic. Each dialect's engines,
column types, codecs and settings are that database's own, read from a pinned
server, because databases differ in ways a schema tool has to respect:
ClickHouse has no foreign keys and rebuilds a table to change its sort key,
where Postgres changes most things in place inside a transaction.

The lexicon is being built in slices (chant #3199). This release carries the
ClickHouse type catalog and its pin; tables, views and materialized views
declared as SQL-shaped tagged templates come next. See
[Where the Types Come From](./clickhouse-catalog/) for the catalog.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
