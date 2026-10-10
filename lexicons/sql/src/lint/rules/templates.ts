/**
 * Finding the ClickHouse tags in a source file, for the source-level rules
 * (and the editor). A rule reads the template's raw parts straight from the
 * TypeScript AST and parses them the way the tag does, with every
 * interpolation left a reference: lint cannot know the values. The finder is
 * the shared core's (`../../core/find-templates.ts`); a tag is ClickHouse's
 * because of the module it is imported from.
 */

import type * as ts from "typescript";
import { tokenize, type Token } from "../../clickhouse/tokens";
import { findSqlTemplates, type FoundTemplate as SqlFoundTemplate, type TemplateSource } from "../../core/find-templates";

export { templatePosition, tokenPosition } from "../../core/find-templates";

export type SqlTag = "database" | "table" | "view" | "dictionary";

/**
 * The ClickHouse tags, by the modules they are imported from. The package
 * root still exports them, so it counts as ClickHouse too.
 */
export const CLICKHOUSE_TEMPLATE_SOURCE: TemplateSource<SqlTag> = {
  dialect: "clickhouse",
  modules: ["@intentius/chant-lexicon-sql", "@intentius/chant-lexicon-sql/clickhouse"],
  tags: ["database", "table", "view", "dictionary"],
};

export type FoundTemplate = SqlFoundTemplate<SqlTag>;

/** Every ClickHouse template in the file (the shared core's finder). */
export function findTemplates(source: ts.SourceFile): FoundTemplate[] {
  return findSqlTemplates(source, [CLICKHOUSE_TEMPLATE_SOURCE]);
}

export const tokensOf = (found: FoundTemplate): Token[] => tokenize(found.parts);
