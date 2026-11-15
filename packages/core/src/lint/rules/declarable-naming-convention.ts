import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isImportedSource } from "./imported-source";

/**
 * COR005: declarable-naming-convention
 *
 * Exported declarable instances (i.e. `export const x = new SomeClass(...)`)
 * must use camelCase names. Flags PascalCase and UPPER_SNAKE_CASE names.
 *
 * Triggers on: export const DataBucket = new Bucket({ ... })
 * Triggers on: export const DATA_BUCKET = new Bucket({ ... })
 * OK: export const dataBucket = new Bucket({ ... })
 * OK: export const DataBucket = createBucket({ ... })  (not a new expression)
 * OK: const DataBucket = new Bucket({ ... })  (not exported)
 * OK: any name in a file written by `chant import` (see imported-source.ts)
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isVariableStatement(node)) {
    const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) {
      ts.forEachChild(node, child => checkNode(child, context, diagnostics));
      return;
    }

    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer || !ts.isNewExpression(decl.initializer)) continue;

      const name = decl.name.text;
      // camelCase starts with lowercase — that's fine
      if (/^[a-z]/.test(name)) continue;

      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        decl.name.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR005",
        severity: "warning",
        message: `Declarable '${name}' should use camelCase naming — rename to '${toCamelCase(name)}'.`,
      });
    }
  }

  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

/**
 * Suggest a camelCase version of a PascalCase or UPPER_SNAKE_CASE name.
 *
 * The name is cut at every character an identifier cannot start a word with
 * (`_`, `$`), the same non-alphanumeric cut the Kubernetes importer makes in
 * `toLogicalId`. A leading run of capitals is an acronym: it is lowercased up
 * to the capital that begins the next word, so `TFStateBucket` gives
 * `tfStateBucket` and `OBSAdminUser` gives `obsAdminUser`. That boundary is
 * a case boundary inside one identifier, which `toLogicalId` (names joined
 * from DNS-style segments) never has to find, so the two stay separate.
 */
export function toCamelCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  if (words.length === 0) return name;
  return words
    .map((word, i) => {
      // A word written entirely in capitals ("BUCKET", "S3") is one word.
      const allCaps = word === word.toUpperCase() && /[A-Z]/.test(word);
      if (i === 0) return lowerLeadingCapitals(word, allCaps);
      return word[0].toUpperCase() + (allCaps ? word.slice(1).toLowerCase() : word.slice(1));
    })
    .join("");
}

/** Lowercase the leading capitals of a word, keeping the capital that starts its next word. */
function lowerLeadingCapitals(word: string, allCaps: boolean): string {
  if (allCaps) return word.toLowerCase();
  const run = /^[A-Z]+/.exec(word)?.[0] ?? "";
  // "TFState": the run is "TFS", and its last capital starts "State".
  const startsNextWord = run.length > 1 && /[a-z]/.test(word[run.length] ?? "");
  const keep = startsNextWord ? run.length - 1 : Math.max(run.length, 1);
  return word.slice(0, keep).toLowerCase() + word.slice(keep);
}

export const declarableNamingConventionRule: LintRule = {
  id: "COR005",
  severity: "warning",
  category: "style",
  description: "Exported declarable instances must use camelCase naming",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    if (isImportedSource(context.sourceFile)) return diagnostics;
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
