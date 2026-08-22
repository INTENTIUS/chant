#!/usr/bin/env npx tsx
/**
 * One-off migration helper (chant #1734): lift `extraPages[].content`
 * template literals out of a lexicon's `src/codegen/docs.ts` into
 * `docs/pages/<slug>.mdx`, ready for a `diataxis` field.
 *
 *   npx tsx scripts/extract-lexicon-doc-pages.ts <lexicon>
 *
 * Finds every object literal with `slug`, `title` and `content` properties,
 * whether inline in the `extraPages` array or hoisted to a `const`. Takes the
 * cooked text of the content literal (so `\`` and `\${` are already resolved).
 * A content value that is not a plain literal — a template with real
 * substitutions, a function call — is reported as SKIP for hand extraction.
 * Does not modify docs.ts; delete the entries after reviewing the output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const lexicon = process.argv[2];
if (!lexicon) {
  console.error("usage: npx tsx scripts/extract-lexicon-doc-pages.ts <lexicon>");
  process.exit(2);
}

const root = join(import.meta.dirname, "..");
const docsTs = join(root, "lexicons", lexicon, "src", "codegen", "docs.ts");
const pagesDir = join(root, "lexicons", lexicon, "docs", "pages");
if (!existsSync(docsTs)) {
  console.error(`no ${docsTs}`);
  process.exit(2);
}

const source = ts.createSourceFile(docsTs, readFileSync(docsTs, "utf-8"), ts.ScriptTarget.Latest, true);

/** Top-level `const NAME = <expr>` declarations, so a hoisted literal can be followed once. */
const consts = new Map<string, ts.Expression>();
function collectConsts(file: ts.SourceFile): void {
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer && !consts.has(decl.name.text)) {
        consts.set(decl.name.text, decl.initializer);
      }
    }
  }
}
collectConsts(source);
// Named imports from sibling modules (`import { dogwoodOverview } from "./docs-dogwood"`)
// are followed one level, so a page whose prose is hoisted to its own file still extracts.
for (const stmt of source.statements) {
  if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
  const spec = stmt.moduleSpecifier.text;
  if (!spec.startsWith(".")) continue;
  const candidates = [`${spec}.ts`, `${spec}/index.ts`].map((c) => join(root, "lexicons", lexicon, "src", "codegen", c));
  const path = candidates.find((c) => existsSync(c));
  if (!path) continue;
  collectConsts(ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true));
}

function literalText(expr: ts.Expression, depth = 0): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isStringLiteral(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr)) return literalText(expr.expression, depth);
  if (ts.isIdentifier(expr) && depth === 0) {
    const init = consts.get(expr.text);
    return init ? literalText(init, depth + 1) : null;
  }
  // `a + b` of plain literals.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalText(expr.left, depth);
    const r = literalText(expr.right, depth);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ((ts.isIdentifier(p.name) && p.name.text === name) || (ts.isStringLiteral(p.name) && p.name.text === name))) {
      return p.initializer;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

interface Page { slug: string; title: string; description?: string; content: string | null }
const pages: Page[] = [];
const seen = new Set<string>();

function visit(node: ts.Node): void {
  if (ts.isObjectLiteralExpression(node)) {
    const slugE = prop(node, "slug");
    const titleE = prop(node, "title");
    const contentE = prop(node, "content");
    if (slugE && titleE && contentE) {
      const slug = literalText(slugE);
      const title = literalText(titleE);
      if (slug && title && !seen.has(slug)) {
        seen.add(slug);
        const descE = prop(node, "description");
        pages.push({
          slug,
          title,
          description: descE ? literalText(descE) ?? undefined : undefined,
          content: literalText(contentE),
        });
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

if (pages.length === 0) {
  console.log(`${lexicon}: no extraPages entries found`);
  process.exit(0);
}

mkdirSync(pagesDir, { recursive: true });
let written = 0;
for (const p of pages) {
  if (p.content === null) {
    console.log(`SKIP ${p.slug}: needs manual extraction (content is not a plain literal)`);
    continue;
  }
  const fm = [
    "---",
    `title: ${JSON.stringify(p.title)}`,
    p.description ? `description: ${JSON.stringify(p.description)}` : null,
    "diataxis: TODO",
    "---",
    "",
  ].filter((l): l is string => l !== null);
  writeFileSync(join(pagesDir, `${p.slug}.mdx`), `${fm.join("\n")}\n${p.content.trimEnd()}\n`);
  console.log(`wrote docs/pages/${p.slug}.mdx`);
  written++;
}
console.log(`${lexicon}: ${written} written, ${pages.length - written} skipped`);
