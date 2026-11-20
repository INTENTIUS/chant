import type { LintContext, LintDiagnostic, LintRule } from "../rule";
import { foldPipelineSource, PIPELINE_FOLD_RULE } from "../../pipeline/fold";

/**
 * EVL012: a pipeline declaration that does not fold (#5324).
 *
 * A member's `.chant/pipeline.ts` is folded, never run. This rule runs the
 * same fold `chant build` runs and reports its finding at the same line, so
 * `chant lint`, the LSP and the build agree. A subset violation keeps the
 * rule id the classifier gives it (EVL001, EVL003); a file whose shape is
 * not a pipeline declaration, or a declaration the spec check refuses, is
 * EVL012.
 */

/** Whether `path` is a member's pipeline declaration. */
export function isPipelineFile(path: string): boolean {
  return /(^|[\\/])\.chant[\\/]pipeline\.ts$/.test(path);
}

export const evl012PipelineFoldRule: LintRule = {
  id: PIPELINE_FOLD_RULE,
  severity: "error",
  category: "correctness",
  description: "A pipeline declaration (.chant/pipeline.ts) folds to its spec without running: literals, consts and `export default pipeline({ ... })`",
  check(context: LintContext): LintDiagnostic[] {
    if (!isPipelineFile(context.filePath)) return [];
    const folded = foldPipelineSource(context.sourceFile.getFullText(), context.filePath);
    if ("spec" in folded) return [];
    const { finding } = folded;
    return [{ file: context.filePath, line: finding.line, column: finding.column, ruleId: finding.ruleId, severity: "error", message: `The pipeline does not fold: ${finding.message}` }];
  },
};
