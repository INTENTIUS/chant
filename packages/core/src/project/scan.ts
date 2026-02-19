import { readdirSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import ts from "typescript";

export interface ProjectExport {
  name: string;
  file: string;
  className: string;
}

export interface ProjectScan {
  barrelPath: string;
  lexiconPackage: string;
  exports: ProjectExport[];
}

/**
 * Extract the lexicon package from export * declarations in the barrel file.
 * Finds the first `export * from "..."` where the module specifier is not a relative path.
 */
function extractLexiconPackage(sourceFile: ts.SourceFile): string {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.exportClause &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!spec.startsWith(".")) {
        return spec;
      }
    }
  }
  return "";
}

/**
 * Infer class name from a variable declaration's initializer or type annotation.
 *
 * Patterns:
 * - `export const x = new aws.Bucket(...)` → "Bucket"
 * - `export const x = new _.Bucket(...)` → "Bucket"
 * - `export const x = new Bucket(...)` → "Bucket"
 * - `export const x: aws.Code = ...` → "Code"
 * - `export const x: _.Code = ...` → "Code"
 */
function inferClassName(decl: ts.VariableDeclaration): string {
  // Check initializer: new X.ClassName(...) or new ClassName(...)
  if (decl.initializer && ts.isNewExpression(decl.initializer)) {
    const expr = decl.initializer.expression;
    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }
  }

  // Check type annotation: X.ClassName or ClassName
  if (decl.type) {
    if (ts.isTypeReferenceNode(decl.type)) {
      const typeName = decl.type.typeName;
      if (ts.isQualifiedName(typeName)) {
        return typeName.right.text;
      }
      if (ts.isIdentifier(typeName)) {
        return typeName.text;
      }
    }
  }

  return "";
}

/**
 * Extract named exports from a source file.
 */
function extractExports(
  sourceFile: ts.SourceFile,
  filePath: string,
): ProjectExport[] {
  const results: ProjectExport[] = [];

  for (const stmt of sourceFile.statements) {
    // export const x = ...
    if (
      ts.isVariableStatement(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          results.push({
            name: decl.name.text,
            file: filePath,
            className: inferClassName(decl),
          });
        }
      }
    }

    // export function x() {}
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      stmt.name
    ) {
      results.push({
        name: stmt.name.text,
        file: filePath,
        className: "",
      });
    }

    // export class X {}
    if (
      ts.isClassDeclaration(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      stmt.name
    ) {
      results.push({
        name: stmt.name.text,
        file: filePath,
        className: stmt.name.text,
      });
    }
  }

  return results;
}

/**
 * Scan a project directory to identify the barrel file, lexicon package,
 * and all exports with their inferred types.
 */
export function scanProject(dir: string): ProjectScan {
  const barrelPath = join(dir, "_.ts");

  let barrelContent: string;
  try {
    barrelContent = readFileSync(barrelPath, "utf-8");
  } catch {
    throw new Error(`No barrel file found at ${barrelPath}`);
  }

  const barrelSource = ts.createSourceFile(
    "_.ts",
    barrelContent,
    ts.ScriptTarget.Latest,
    true,
  );

  const lexiconPackage = extractLexiconPackage(barrelSource);

  // Scan sibling .ts files
  const entries = readdirSync(dir, { withFileTypes: true });
  const exports: ProjectExport[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name === "_.ts") continue;
    if (entry.name.startsWith("_")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))
      continue;
    if (entry.name.endsWith(".d.ts")) continue;

    const filePath = "./" + entry.name.replace(/\.ts$/, "");
    const fullPath = join(dir, entry.name);
    const content = readFileSync(fullPath, "utf-8");
    const sourceFile = ts.createSourceFile(
      entry.name,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    exports.push(...extractExports(sourceFile, filePath));
  }

  return { barrelPath, lexiconPackage, exports };
}
