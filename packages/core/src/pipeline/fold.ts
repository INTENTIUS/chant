/**
 * Fold a pipeline declaration to its spec without running it (#5324).
 *
 * `.chant/pipeline.ts` is written inside the TypeScript-as-data subset: an
 * `import { pipeline } from "@intentius/chant/pipeline"`, top-level `const`s
 * of literals, and `export default pipeline({ ... })`. The fold reads the
 * file's text and reduces the argument with the same `fold()` a resource
 * file goes through (`../fold/fold.ts`). Nothing is imported and nothing
 * runs, so the gates can fold the file as it stood at the base commit.
 *
 * Unlike a resource file, a pipeline file outside the subset never falls
 * back to running. The fold refuses it with a finding: the evaluability
 * rule's id (EVL001 or EVL003 from the subset classifier, or EVL012 for a
 * file whose shape is not a pipeline declaration), the line and column, and
 * the reason. `chant build`, `chant lint` and the LSP report that finding.
 */

import * as ts from "typescript";
import { collectConsts, fold, FoldError } from "../fold/fold";
import { asPipelineSpec, type PipelineSpec } from "./spec";

/** The evaluability rule a pipeline file whose shape is not a declaration breaks. */
export const PIPELINE_FOLD_RULE = "EVL012";

/** The module a pipeline file imports its helper from. */
export const PIPELINE_MODULE = "@intentius/chant/pipeline";

/** Why a pipeline file did not fold, located in the file. */
export interface PipelineFinding {
  ruleId: string;
  line: number;
  column: number;
  message: string;
}

/** The fold's outcome: the spec, or the first finding. */
export type PipelineFold = { spec: PipelineSpec } | { finding: PipelineFinding };

class Refused extends Error {
  constructor(
    message: string,
    readonly node: ts.Node,
    readonly ruleId: string = PIPELINE_FOLD_RULE,
  ) {
    super(message);
  }
}

function at(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: line + 1, column: character + 1 };
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

const isExported = (node: ts.Node): boolean => (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ?? false;

/** The local names the file binds to the pipeline helper. */
function helperNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    const clause = statement.importClause;
    if (from !== PIPELINE_MODULE) {
      // A type-only import adds no value, so it cannot carry one in.
      if (clause?.isTypeOnly) continue;
      throw new Refused(`a pipeline file imports only from ${PIPELINE_MODULE}; "${from}" would bring in a value the fold cannot read`, statement);
    }
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) throw new Refused(`${PIPELINE_MODULE} has no default export; import { pipeline }`, clause.name);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) throw new Refused(`import { pipeline } from "${PIPELINE_MODULE}" by name, not as a namespace`, bindings);
    for (const el of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
      if (el.isTypeOnly) continue;
      if ((el.propertyName ?? el.name).text === "pipeline") names.add(el.name.text);
    }
  }
  return names;
}

function declarationOf(source: ts.SourceFile, helpers: Set<string>): ts.Expression {
  let found: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) throw new Refused("a pipeline file exports its declaration with `export default`", statement);
      found = statement.expression;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) throw new Refused("a pipeline file declares only `const`s; a `let` or `var` can change before it is read", statement);
      if (isExported(statement)) throw new Refused("a pipeline file exports one thing, `export default pipeline({ ... })`", statement);
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) throw new Refused("a destructured `const` is not read in a pipeline file", d);
        if (!d.initializer) throw new Refused(`\`const ${d.name.text}\` has no value`, d);
      }
      continue;
    }
    throw new Refused(`a pipeline file holds imports, \`const\`s and \`export default pipeline({ ... })\`; this ${ts.SyntaxKind[statement.kind]} is outside the subset`, statement);
  }
  if (!found) throw new Refused("a pipeline file ends with `export default pipeline({ ... })`", source);
  const call = unwrap(found);
  if (ts.isCallExpression(call)) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) || !helpers.has(callee.text)) throw new Refused(`the declaration is \`pipeline({ ... })\` with pipeline imported from ${PIPELINE_MODULE}`, call.expression);
    if (call.arguments.length !== 1) throw new Refused("`pipeline()` takes one object, the declaration", call);
    return call.arguments[0]!;
  }
  // A plain object literal folds as well: the helper only types it.
  return found;
}

/**
 * Fold a pipeline file's text. `file` names it in the messages. Returns the
 * checked spec, or the first finding: a subset violation with the EVL rule
 * the classifier names, a shape that is not a declaration (EVL012), or a
 * declaration the spec check refuses (EVL012, at the export).
 */
export function foldPipelineSource(text: string, file = ".chant/pipeline.ts"): PipelineFold {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let exportNode: ts.Node = source;
  try {
    const helpers = helperNames(source);
    const expr = declarationOf(source, helpers);
    exportNode = expr;
    const value = fold(expr, collectConsts(source));
    const plain = JSON.parse(JSON.stringify(value)) as unknown;
    return { spec: asPipelineSpec(plain, file) };
  } catch (err) {
    if (err instanceof FoldError) return { finding: { ruleId: err.ruleId, line: err.line, column: err.column, message: err.message.replace(/^\d+:\d+ - /, "") } };
    if (err instanceof Refused) return { finding: { ruleId: err.ruleId, ...at(source, err.node), message: err.message } };
    return { finding: { ruleId: PIPELINE_FOLD_RULE, ...at(source, exportNode), message: err instanceof Error ? err.message : String(err) } };
  }
}

/** The one-line form of a finding: `<file>:<line>:<column> [<rule>] <message>`. */
export function pipelineFindingLine(file: string, finding: PipelineFinding): string {
  return `${file}:${finding.line}:${finding.column} [${finding.ruleId}] ${finding.message}`;
}
