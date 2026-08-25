/**
 * Shared helper for gitlab lint rules that match a bare TypeScript
 * identifier (`Job`, ...) and need to know whether it actually came from
 * this lexicon before flagging it (chant #1544 — cross-lexicon rule bleed:
 * `new Job(...)` matches ANY lexicon's `Job` class by name alone, so a
 * multi-lexicon project got gitlab-only rules applied to github/forgejo
 * jobs that were never missing anything).
 */

import * as ts from "typescript";

/**
 * The module specifier a top-level import bound `name` to, whether via a
 * named import (`import { Job } from "..."`, matched on its local —
 * possibly aliased — binding) or a namespace import (`import * as gl from
 * "..."`, matched on the namespace's own name). Undefined when `name` isn't
 * bound by any top-level import in this file (no import at all, a
 * re-export chain, a dynamic `require`, …) — the caller should treat that
 * as "can't tell", not "not gitlab", to stay conservative for the common
 * single-lexicon-project case (and every pre-#1544 unit test fixture, which
 * has no import statements at all).
 */
export function importSourceFor(sourceFile: ts.SourceFile, name: string): string | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpecifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;
    const namedBindings = stmt.importClause?.namedBindings;
    if (!namedBindings) continue;

    if (ts.isNamespaceImport(namedBindings)) {
      if (namedBindings.name.text === name) return moduleSpecifier.text;
    } else if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.name.text === name) return moduleSpecifier.text;
      }
    }
  }
  return undefined;
}

/**
 * True when `expression` (a `new`-expression callee) resolves — via a
 * traced import — to a lexicon OTHER than gitlab. False for an unresolved
 * import (conservative: still checked) or one that does resolve to gitlab.
 */
export function isJobFromAnotherLexicon(sourceFile: ts.SourceFile, expression: ts.LeftHandSideExpression): boolean {
  let bindingName: string | undefined;
  if (ts.isIdentifier(expression)) {
    bindingName = expression.text;
  } else if (ts.isPropertyAccessExpression(expression)) {
    bindingName = ts.isIdentifier(expression.expression) ? expression.expression.text : undefined;
  }
  if (!bindingName) return false;

  const source = importSourceFor(sourceFile, bindingName);
  return source !== undefined && !source.includes("chant-lexicon-gitlab");
}
