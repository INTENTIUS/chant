/**
 * Finding the Postgres tags in a source file, for the source-level rules. A
 * tag is Postgres's because of the module it is imported from: the
 * `/postgres` subpath, or the package root for the tags whose names
 * ClickHouse does not export (the root's `table` and `view` are
 * ClickHouse's).
 */

import type * as ts from "typescript";
import { tokenize, type Token } from "../../postgres/tokens";
import type { PostgresTag } from "../../postgres/entities";
import { findSqlTemplates, type FoundTemplate, type TemplateSource } from "../../core/find-templates";

export { templatePosition, tokenPosition } from "../../core/find-templates";

export const POSTGRES_TEMPLATE_SOURCES: readonly TemplateSource<PostgresTag>[] = [
  {
    dialect: "postgres",
    modules: ["@intentius/chant-lexicon-sql/postgres"],
    tags: ["schema", "table", "index", "view", "sequence", "type", "domain", "extension"],
  },
  {
    dialect: "postgres",
    modules: ["@intentius/chant-lexicon-sql"],
    tags: ["schema", "index", "sequence", "type", "domain", "extension"],
  },
];

export type PostgresFoundTemplate = FoundTemplate<PostgresTag>;

/** Every Postgres template in the file. */
export function findPostgresTemplates(source: ts.SourceFile): PostgresFoundTemplate[] {
  return findSqlTemplates(source, POSTGRES_TEMPLATE_SOURCES);
}

export const postgresTokensOf = (found: PostgresFoundTemplate): Token[] => tokenize(found.parts);
