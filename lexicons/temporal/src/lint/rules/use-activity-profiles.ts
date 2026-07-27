/**
 * TMP020: Use TEMPORAL_ACTIVITY_PROFILES instead of inline activity options
 *
 * `proxyActivities()` (from `@temporalio/workflow`) accepts ActivityOptions —
 * `startToCloseTimeout`, `heartbeatTimeout`, `retry`, etc. Hardcoding those
 * inline scatters timeout/retry tuning across every workflow file instead of
 * the named profiles this lexicon ships (see config.ts's
 * `TEMPORAL_ACTIVITY_PROFILES`), whose whole purpose is keeping that tuning
 * "in the lexicon rather than inline in workflow code."
 *
 * This is a source-level (pre-synth) check with no post-synth counterpart:
 * `proxyActivities()` calls live in plain workflow TypeScript that chant's
 * build pipeline never serializes (only TemporalServer/Namespace/
 * SearchAttribute/Schedule declarables are), so this is the only stage of
 * the pipeline that can see this pattern at all.
 *
 * Flags a `proxyActivities(...)` call whose options object literal declares
 * `startToCloseTimeout` directly. Spreading a named profile — optionally
 * overriding individual fields — is not flagged.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

function hasNamedProperty(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name,
  );
}

export const useActivityProfilesRule: LintRule = {
  id: "TMP020",
  severity: "warning",
  category: "style",
  description: "Use a named TEMPORAL_ACTIVITY_PROFILES entry instead of inline ActivityOptions",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "proxyActivities" &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const options = node.arguments[0] as ts.ObjectLiteralExpression;
        const hasSpread = options.properties.some((p) => ts.isSpreadAssignment(p));
        const timeoutProp = hasNamedProperty(options, "startToCloseTimeout");

        if (timeoutProp && !hasSpread) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(timeoutProp.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "TMP020",
            severity: "warning",
            message:
              "Inline startToCloseTimeout in proxyActivities() — use a named TEMPORAL_ACTIVITY_PROFILES entry (e.g. TEMPORAL_ACTIVITY_PROFILES.longInfra) instead, spreading it with overrides if needed.",
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
