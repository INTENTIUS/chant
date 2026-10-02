/**
 * Finding the ClickHouse tags in a source file, for the source-level rules
 * (and the editor). A rule reads the template's raw parts straight from the
 * TypeScript AST and parses them the way the tag does, with every
 * interpolation left a reference: lint cannot know the values.
 */

import * as ts from "typescript";
import { tokenize, type Token } from "../../clickhouse/tokens";

export type SqlTag = "database" | "table" | "view";

const TAGS = new Set<string>(["database", "table", "view"]);
const MODULES = new Set(["@intentius/chant-lexicon-sql", "@intentius/chant-lexicon-sql/clickhouse"]);

export interface FoundTemplate {
  node: ts.TaggedTemplateExpression;
  tag: SqlTag;
  /** The template's raw parts, backslashes as written. */
  parts: string[];
  /** Source offset of each part's first character. */
  starts: number[];
  /** The source text of each interpolation's expression. */
  expressions: ts.Expression[];
}

/** Local names bound to the sql tags by this file's imports: `{ table as t }` maps `t` to `table`. */
function tagBindings(source: ts.SourceFile): Map<string, SqlTag> {
  const out = new Map<string, SqlTag>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!MODULES.has(stmt.moduleSpecifier.text)) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (TAGS.has(imported)) out.set(el.name.text, imported as SqlTag);
    }
  }
  return out;
}

export function findTemplates(source: ts.SourceFile): FoundTemplate[] {
  const bindings = tagBindings(source);
  if (bindings.size === 0) return [];
  const found: FoundTemplate[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && bindings.has(node.tag.text)) {
      const t = node.template;
      const parts = ts.isNoSubstitutionTemplateLiteral(t)
        ? [t.rawText ?? t.text]
        : [t.head.rawText ?? t.head.text, ...t.templateSpans.map((s) => s.literal.rawText ?? s.literal.text)];
      // A part's text begins one character after its opening delimiter (` or }).
      const starts = ts.isNoSubstitutionTemplateLiteral(t)
        ? [t.getStart(source) + 1]
        : [t.head.getStart(source) + 1, ...t.templateSpans.map((s) => s.literal.getStart(source) + 1)];
      const expressions = ts.isNoSubstitutionTemplateLiteral(t) ? [] : t.templateSpans.map((s) => s.expression);
      found.push({ node, tag: bindings.get(node.tag.text)!, parts, starts, expressions });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 1-based line and column of a template offset. */
export function templatePosition(
  source: ts.SourceFile,
  found: FoundTemplate,
  part: number,
  offset: number,
): { line: number; column: number } {
  const pos = (found.starts[part] ?? found.node.getStart(source)) + offset;
  const { line, character } = source.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

/** A token's position; an interpolation's is its expression's. */
export function tokenPosition(source: ts.SourceFile, found: FoundTemplate, token: Token): { line: number; column: number } {
  if (token.kind === "ref") {
    const expr = found.expressions[token.part];
    if (expr) {
      const { line, character } = source.getLineAndCharacterOfPosition(expr.getStart(source));
      return { line: line + 1, column: character + 1 };
    }
  }
  return templatePosition(source, found, token.part, token.start);
}

export const tokensOf = (found: FoundTemplate): Token[] => tokenize(found.parts);
