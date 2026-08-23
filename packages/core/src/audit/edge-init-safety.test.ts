import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname, resolve } from "path";
import ts from "typescript";

/**
 * #428 / #1621: the lexicon modules the hosted service imports on the edge —
 * the post-synth barrel and the `detect` module, plus everything they reach
 * through static imports — must not build filesystem paths at module load.
 * On workerd `import.meta.url` is undefined and `__dirname`, `require` and
 * `process.cwd()` do not exist, so a module-scope
 * `dirname(fileURLToPath(import.meta.url))` crashes the worker at startup.
 * Anything that genuinely needs a path must compute it lazily, inside a
 * function, behind a try.
 *
 * The old guard only grepped the post-synth files themselves for
 * `createRequire`. azure's `deploy-scopes.ts` (reached from azr030) used
 * `fileURLToPath` and slipped through. This version walks the transitive
 * relative-import graph of every barrel with the TypeScript parser and flags
 * the whole family of constructions at module scope.
 */
const lexiconsDir = fileURLToPath(new URL("../../../../lexicons", import.meta.url));

function barrels(): string[] {
  const out: string[] = [];
  for (const lex of readdirSync(lexiconsDir)) {
    const detect = join(lexiconsDir, lex, "src", "detect.ts");
    if (existsSync(detect)) out.push(detect);
    const ps = join(lexiconsDir, lex, "src", "lint", "post-synth");
    if (existsSync(ps)) {
      const index = join(ps, "index.ts");
      if (existsSync(index)) out.push(index);
      // Checks not re-exported from the barrel are still edge-imported
      // individually by the hosted service, so keep them as roots too.
      for (const f of readdirSync(ps)) {
        if (f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts") out.push(join(ps, f));
      }
    }
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Resolve a relative specifier to a .ts file the way the lexicon tsconfigs do. */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Static (non-type-only) imports and re-exports of a file, resolved to paths. */
function staticImports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    let spec: string | undefined;
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue;
      spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (stmt.isTypeOnly) continue;
      spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    }
    if (!spec || !spec.startsWith(".")) continue;
    const resolved = resolveRelative(sf.fileName, spec);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Every file reachable from the roots through static relative imports. */
function transitiveClosure(roots: string[]): Map<string, ts.SourceFile> {
  const seen = new Map<string, ts.SourceFile>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const sf = parse(file);
    seen.set(file, sf);
    for (const dep of staticImports(sf)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function containsImportMetaUrl(node: ts.Node): boolean {
  if (isImportMetaUrl(node)) return true;
  return ts.forEachChild(node, containsImportMetaUrl) ?? false;
}

/** Describe a module-scope path construction, or undefined if `node` is benign. */
function offense(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) && (node.text === "__dirname" || node.text === "__filename")) {
    // `const __dirname_ = ...` is a declaration, not a use of the Node global.
    if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return undefined;
    return node.text;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (callee.text === "require") return "require(...)";
      if ((callee.text === "fileURLToPath" || callee.text === "createRequire") && node.arguments.some(containsImportMetaUrl)) {
        return `${callee.text}(import.meta.url)`;
      }
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "process" &&
      callee.name.text === "cwd"
    ) {
      return "process.cwd()";
    }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.some(containsImportMetaUrl)) {
    return "new URL(..., import.meta.url)";
  }
  return undefined;
}

/** Bodies that run later than module evaluation. */
function defersEvaluation(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  );
}

function moduleScopeOffenses(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (defersEvaluation(node)) return;
    const what = offense(node);
    if (what) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${sf.fileName.replace(lexiconsDir, "lexicons")}:${line + 1}: ${what}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

describe("edge-imported lexicon modules are init-safe", () => {
  test("reaches helpers through the barrel import graph", () => {
    const files = [...transitiveClosure(barrels()).keys()];
    expect(files).toContain(join(lexiconsDir, "azure", "src", "deploy-scopes.ts"));
  });

  test("no module-scope filesystem-path constructions in the transitive import graph", () => {
    const offenders: string[] = [];
    for (const sf of transitiveClosure(barrels()).values()) offenders.push(...moduleScopeOffenses(sf));
    expect(offenders, "move these into a function (lazy) — they crash edge bundles").toEqual([]);
  });
});
