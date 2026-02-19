import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WAW001: Hardcoded AWS Region
 *
 * Detects hardcoded AWS region strings in code.
 * Regions should use AWS.Region pseudo-parameter instead.
 */
export const hardcodedRegionRule: LintRule = {
  id: "WAW001",
  severity: "warning",
  category: "security",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    // Common AWS region patterns
    const regionPattern = /^(us|eu|ap|sa|ca|me|af|cn)-(north|south|east|west|central|northeast|southeast)-\d$/;

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const value = node.text;
        if (regionPattern.test(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WAW001",
            severity: "warning",
            message: `Hardcoded region "${value}" detected. Use AWS.Region pseudo-parameter instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
