/**
 * Finding a dialect's tags in a source file, for source-level lint rules and
 * the editor (chant #3278). A rule reads a template's raw parts straight from
 * the TypeScript AST and parses them the way the tag does, with every
 * interpolation left a reference: lint cannot know the values.
 *
 * Every dialect exports tags with the same names (`table`, `view`), so a tag
 * is a dialect's by the module it is imported from, never by its name.
 */

import * as ts from "typescript";
import type { Token } from "./tokens";
import { unescapeTemplateDelimiters } from "./template";

/** Which imports make a tag one dialect's. */
export interface TemplateSource<Tag extends string = string> {
  /** The dialect, as `sql.dialect` names it. */
  dialect: string;
  /** The module specifiers its tags are imported from. */
  modules: readonly string[];
  /** The tag names it exports. */
  tags: readonly Tag[];
}

export interface FoundTemplate<Tag extends string = string> {
  node: ts.TaggedTemplateExpression;
  /** The dialect whose module the tag was imported from. */
  dialect: string;
  tag: Tag;
  /** The template's raw parts, backslashes as written. */
  parts: string[];
  /** Source offset of each part's first character. */
  starts: number[];
  /** The source text of each interpolation's expression. */
  expressions: ts.Expression[];
}

/** Local names bound to the dialects' tags by this file's imports: `{ table as t }` maps `t` to `table`. */
function tagBindings<Tag extends string>(source: ts.SourceFile, sources: readonly TemplateSource<Tag>[]): Map<string, { dialect: string; tag: Tag }> {
  const out = new Map<string, { dialect: string; tag: Tag }>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    // A module may export several dialects' tags (the package root does): a tag is the first source's that names it.
    const from = sources.filter((s) => s.modules.includes((stmt.moduleSpecifier as ts.StringLiteral).text));
    if (from.length === 0) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      const source = from.find((s) => (s.tags as readonly string[]).includes(imported));
      if (source) out.set(el.name.text, { dialect: source.dialect, tag: imported as Tag });
    }
  }
  return out;
}

/** Every template in `source` whose tag is imported from one of `sources`' modules, in source order. */
export function findSqlTemplates<Tag extends string>(source: ts.SourceFile, sources: readonly TemplateSource<Tag>[]): FoundTemplate<Tag>[] {
  const bindings = tagBindings(source, sources);
  if (bindings.size === 0) return [];
  const found: FoundTemplate<Tag>[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && bindings.has(node.tag.text)) {
      const t = node.template;
      // As the tag reads them: raw, with `\`` and `\${` undone. An offset after one of those is off by one.
      const parts = (
        ts.isNoSubstitutionTemplateLiteral(t)
          ? [t.rawText ?? t.text]
          : [t.head.rawText ?? t.head.text, ...t.templateSpans.map((s) => s.literal.rawText ?? s.literal.text)]
      ).map(unescapeTemplateDelimiters);
      // A part's text begins one character after its opening delimiter (` or }).
      const starts = ts.isNoSubstitutionTemplateLiteral(t)
        ? [t.getStart(source) + 1]
        : [t.head.getStart(source) + 1, ...t.templateSpans.map((s) => s.literal.getStart(source) + 1)];
      const expressions = ts.isNoSubstitutionTemplateLiteral(t) ? [] : t.templateSpans.map((s) => s.expression);
      const { dialect, tag } = bindings.get(node.tag.text)!;
      found.push({ node, dialect, tag, parts, starts, expressions });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 1-based line and column of a template offset. */
export function templatePosition(source: ts.SourceFile, found: FoundTemplate, part: number, offset: number): { line: number; column: number } {
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

// ── The editor ─────────────────────────────────────────────────────────

/** The offset of an LSP position (0-based line and character) in `content`. */
export function offsetAt(content: string, pos: { line: number; character: number }): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return Math.min(offset + pos.character, content.length);
}

export interface Located<Tag extends string = string> {
  source: ts.SourceFile;
  found: FoundTemplate<Tag>;
  /** The template part the cursor is in, or -1 when it is inside an interpolation's expression. */
  part: number;
  /** Offset in that part. */
  offset: number;
  /** The interpolation the cursor is in, when part is -1. */
  expression: number;
  /** Absolute source offset. */
  at: number;
}

/** The template the source offset `at` is inside, and where in it. */
export function locateIn<Tag extends string>(content: string, at: number, sources: readonly TemplateSource<Tag>[], fileName = "file.ts"): Located<Tag> | undefined {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  for (const found of findSqlTemplates(source, sources)) {
    const start = found.node.template.getStart(source);
    const end = found.node.template.getEnd();
    if (at <= start || at >= end) continue;
    for (let i = 0; i < found.parts.length; i++) {
      const from = found.starts[i]!;
      if (at >= from && at <= from + found.parts[i]!.length) {
        return { source, found, part: i, offset: at - from, expression: -1, at };
      }
    }
    const expression = found.expressions.findIndex((e) => at >= e.getStart(source) && at <= e.getEnd());
    return { source, found, part: -1, offset: 0, expression, at };
  }
  return undefined;
}

const WORD = /[A-Za-z0-9_]/;

/** The identifier characters around an offset in a part. */
export function wordAround(text: string, offset: number): { start: number; end: number } {
  let start = offset;
  while (start > 0 && WORD.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && WORD.test(text[end]!)) end++;
  return { start, end };
}
