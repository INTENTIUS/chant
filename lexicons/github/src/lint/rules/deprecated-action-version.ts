/**
 * GHA012: Deprecated Action Version
 *
 * Flags `uses:` strings referencing deprecated action versions.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";
import { deprecatedVersions } from "./data/deprecated-versions";

export const deprecatedActionVersionRule: LintRule = {
  id: "GHA012",
  severity: "warning",
  category: "correctness",
  description: "Action version is deprecated — upgrade to the recommended version",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const text = node.text;
        const atIndex = text.indexOf("@");
        if (atIndex === -1) { ts.forEachChild(node, visit); return; }

        const actionName = text.slice(0, atIndex);
        const version = text.slice(atIndex + 1);
        const info = deprecatedVersions[actionName];

        if (info && info.deprecated.includes(version)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "GHA012",
            severity: "warning",
            message: `"${text}" uses deprecated version ${version}. Upgrade to ${actionName}@${info.recommended}.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
