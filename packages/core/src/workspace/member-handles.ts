/**
 * A chant member's outputs and parameters, read from its source without
 * running it (#2539, #2524 D6).
 *
 * `chant workspace check` resolves member links in source and never runs
 * member code, so it can't build a member to learn its outputs. This reader
 * parses the member's TypeScript files and picks out the two handles a join
 * uses, the way the graph IR names them (`exports` and `imports`):
 *
 * - an output is the name passed to `output(ref, "Name")`, or the binding of
 *   `export const name = stackOutput(ref)`;
 * - a parameter is the binding of `export const name = new Parameter(...)`.
 *
 * Only calls whose function is imported from `@intentius/chant` or a chant
 * lexicon count. An output name must be a string literal, or a `const` in the
 * same file that is one. Any other name can't be read without running the
 * code, so it is a gap: the member's list of outputs is then incomplete, and a
 * link to a name the reader didn't find is unresolved rather than missing.
 *
 * The reader loads the TypeScript parser and nothing else from the project.
 */

import * as ts from "typescript";
import { isInside, type Declaration, type ResolvedGroup } from "./declaration";
import type { KindRegistry } from "./kinds";
import { kindHandles, type MemberHandles } from "./links";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";

const memberDir = (dir: string) => (dir === "." ? "" : dir);

/** One output or parameter found in source. */
export interface SourceHandle {
  name: string;
  /** Tree-relative file and 1-based line, for messages. */
  file: string;
  line: number;
}

export interface SourceHandles {
  outputs: SourceHandle[];
  /** Parameters: the names a consumer reads from outside. */
  inputs: SourceHandle[];
  /** Why the list of outputs may be incomplete, one line each. Empty when it is complete. */
  gaps: string[];
}

/** Directories inside a member that hold no project source. */
const NOT_SOURCE = new Set(["dist", "coverage", "generated"]);

const CHANT_MODULE = /^@intentius\/chant(-lexicon-[a-z0-9-]+)?(\/.*)?$/;

function isSourceFile(name: string): boolean {
  if (!/\.(m?ts|tsx)$/.test(name) || name.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.m?tsx?$/.test(name)) return false;
  return !name.startsWith("chant.config.");
}

/**
 * Every source file under `dir` (tree-relative), leaving out `exclude`d
 * directories (other members, group matches), `node_modules`, dot
 * directories and build output.
 */
function sourceFiles(tree: WorkspaceTree, dir: string, exclude: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of tree.list(at) ?? []) {
      const path = joinPath(at, e.name);
      if (e.type === "dir") {
        if (skippedDir(e.name) || NOT_SOURCE.has(e.name) || exclude.has(path)) continue;
        walk(path);
      } else if (isSourceFile(e.name)) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The chant functions a file imports, by local name, and the namespaces it imports chant modules as. */
interface ChantImports {
  names: Map<string, string>;
  namespaces: Set<string>;
}

function chantImports(source: ts.SourceFile): ChantImports {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const from = s.moduleSpecifier.text;
    // The components API has its own stackOutput(stack, name), which reads an output rather than declaring one.
    if (!CHANT_MODULE.test(from) || from.includes("/components")) continue;
    const bindings = s.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const el of bindings.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return { names, namespaces };
}

/** The chant function a callee names (`output`, `ns.Parameter`), or undefined. */
function chantCallee(expr: ts.Expression, imports: ChantImports): string | undefined {
  if (ts.isIdentifier(expr)) return imports.names.get(expr.text);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && imports.namespaces.has(expr.expression.text)) {
    return expr.name.text;
  }
  return undefined;
}

/** The top-level `const` initializers of a file, for reading a name held in one. */
function fileConsts(source: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  for (const s of source.statements) {
    if (!ts.isVariableStatement(s) || (s.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
  }
  return consts;
}

/** A string the expression is without running anything, or undefined. */
function literalString(expr: ts.Expression, consts: Map<string, ts.Expression>, seen = new Set<string>()): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return literalString(expr.expression, consts, seen);
  if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
    const init = consts.get(expr.text);
    if (init) return literalString(init, consts, new Set([...seen, expr.text]));
  }
  return undefined;
}

function isExported(s: ts.Statement): boolean {
  return (ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Read one file's outputs and parameters into `out`. */
function readFile(path: string, text: string, out: SourceHandles): void {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const imports = chantImports(source);
  if (imports.names.size === 0 && imports.namespaces.size === 0) return;
  const consts = fileConsts(source);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  // Exported bindings: stackOutput outputs and Parameter inputs are named by them.
  for (const s of source.statements) {
    if (!ts.isVariableStatement(s) || !isExported(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = d.initializer;
      if (ts.isNewExpression(init) && chantCallee(init.expression, imports) === "Parameter") {
        out.inputs.push({ name: d.name.text, file: path, line: lineOf(d) });
      } else if (ts.isCallExpression(init) && chantCallee(init.expression, imports) === "stackOutput") {
        const first = init.arguments[0];
        if (first && !ts.isStringLiteralLike(first)) out.outputs.push({ name: d.name.text, file: path, line: lineOf(d) });
      }
    }
  }

  // output(ref, "Name") anywhere in the file.
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && chantCallee(node.expression, imports) === "output" && node.arguments.length >= 2) {
      const name = literalString(node.arguments[1], consts);
      if (name !== undefined) out.outputs.push({ name, file: path, line: lineOf(node) });
      else out.gaps.push(`${path}:${lineOf(node)}: an output whose name is not a string literal`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/**
 * Read a chant member's outputs and parameters from the source under `dir`
 * (tree-relative, `""` for the root), leaving out the `exclude`d directories.
 * Runs no member code.
 */
export function readSourceHandles(tree: WorkspaceTree, dir: string, exclude: ReadonlySet<string> = new Set()): SourceHandles {
  const out: SourceHandles = { outputs: [], inputs: [], gaps: [] };
  for (const file of sourceFiles(tree, dir, exclude)) {
    let text: string;
    try {
      text = tree.read(file);
    } catch {
      out.gaps.push(`${file}: the file could not be read`);
      continue;
    }
    readFile(file, text, out);
  }
  return out;
}

/**
 * Every member's handles, read in source for `chant workspace check`. A
 * `chant` member's outputs and parameters are parsed from its TypeScript
 * without running it; other kinds expose what the kind and the entry list.
 * A member whose directory is missing or whose kind is unknown is left out,
 * so links to it are unresolved.
 */
export function sourceMemberHandles(
  declaration: Declaration,
  tree: WorkspaceTree,
  groups: readonly ResolvedGroup[],
  kinds: KindRegistry,
): Map<string, MemberHandles> {
  const out = new Map<string, MemberHandles>();
  for (const m of declaration.members) {
    const kind = kinds.get(m.kind);
    if (!kind || tree.stat(memberDir(m.dir)) !== "dir") continue;
    const listed = kindHandles(m, kind);
    if (listed) {
      out.set(m.name, listed);
    } else {
      // Other members' directories and group matches inside this one are not its source.
      const exclude = new Set<string>();
      for (const o of declaration.members) if (o !== m && o.dir !== "." && isInside(o.dir, m.dir)) exclude.add(o.dir);
      for (const g of groups) for (const dir of g.matches) if (isInside(dir, m.dir)) exclude.add(dir);
      const read = readSourceHandles(tree, memberDir(m.dir), exclude);
      out.set(m.name, {
        member: m.name,
        outputs: read.outputs.map((o) => ({ name: o.name })),
        inputs: read.inputs.map((i) => ({ name: i.name })),
        complete: read.gaps.length === 0,
        why: read.gaps.length === 0 ? null : read.gaps.length === 1 ? read.gaps[0] : `${read.gaps[0]}, and ${read.gaps.length - 1} more`,
        exposesNone: false,
      });
    }
  }
  return out;
}
