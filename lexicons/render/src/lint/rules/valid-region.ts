import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Render's regions, per the `region` enum in the Public API spec. The generated
 * types already narrow `region` to this union, so a typo is a compile error in
 * a typed project; this rule gives the same answer with a clearer message, and
 * fires in contexts the type checker does not reach (a `.js` stack, a value
 * that has been widened to `string`).
 */
export const KNOWN_REGIONS = new Set<string>(["frankfurt", "oregon", "ohio", "singapore", "virginia"]);

/**
 * REN001: Valid Render region
 *
 * A service, datastore, or Key Value `region` must be a Render region.
 */
export const validRegionRule: LintRule = {
  id: "REN001",
  severity: "error",
  category: "correctness",
  description: "A region must be a Render region (frankfurt, oregon, ohio, singapore, virginia)",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === "region") {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && init.text.length > 0 && !KNOWN_REGIONS.has(init.text)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(init.getStart(sourceFile));
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "REN001",
            severity: "error",
            message: `Unknown Render region "${init.text}". Use one of: ${[...KNOWN_REGIONS].join(", ")}.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
