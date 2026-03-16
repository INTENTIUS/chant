/**
 * GHA007: File Job Limit
 *
 * Flags files with more than 10 Job/ReusableWorkflowCallJob constructors.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const JOB_NAMES = new Set(["Job", "ReusableWorkflowCallJob"]);
const MAX_JOBS = 10;

export const fileJobLimitRule: LintRule = {
  id: "GHA007",
  severity: "warning",
  category: "style",
  description: "Too many jobs in a single file",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];
    let jobCount = 0;

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
        let isJob = false;
        if (ts.isIdentifier(node.expression)) isJob = JOB_NAMES.has(node.expression.text);
        if (ts.isPropertyAccessExpression(node.expression)) isJob = JOB_NAMES.has(node.expression.name.text);
        if (isJob) jobCount++;
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    if (jobCount > MAX_JOBS) {
      diagnostics.push({
        file: sourceFile.fileName,
        line: 1,
        column: 1,
        ruleId: "GHA007",
        severity: "warning",
        message: `File has ${jobCount} job constructors (limit: ${MAX_JOBS}). Consider splitting into multiple files.`,
      });
    }

    return diagnostics;
  },
};
