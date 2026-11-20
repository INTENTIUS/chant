/**
 * `@intentius/chant/pipeline` (#5324): one TypeScript declaration of a
 * member's delivery pipeline, its stages in promotion order and the waves
 * inside each, folded to a spec before anything runs.
 *
 * A member's `.chant/pipeline.ts` holds the declaration:
 *
 * ```ts
 * import { pipeline } from "@intentius/chant/pipeline";
 *
 * export default pipeline({
 *   name: "shop",
 *   defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
 *   stages: [
 *     { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
 *     { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { quorum: [{ count: 2 }] } },
 *   ],
 * });
 * ```
 *
 * `chant build` folds it (`./pipeline/fold.ts`) and writes the spec to
 * `.chant/pipeline.json`; a file outside the TypeScript-as-data subset is
 * refused with the evaluability rule's id. See the pipeline guide.
 */

import { NEXT_RELEASE } from "./release-floors";
import type { PipelineDeclaration } from "./pipeline/spec";

/**
 * The first chant with the pipeline declaration (#5324): `.chant/pipeline.ts`
 * folded by `chant build`, `chant pipeline spec` and `chant pipeline
 * generate`, stage gates, holds and freeze windows on `components promote`,
 * a wave's `failureTolerance`, and the product helpers here. A product
 * feature-detects the pipeline on this name.
 */
export const PIPELINE_FLOOR = NEXT_RELEASE;

/**
 * The declaration, typed. It returns its argument: the fold reads the
 * argument's text, and a run that imports the file gets the same object.
 */
export function pipeline(declaration: PipelineDeclaration): PipelineDeclaration {
  return declaration;
}

export * from "./pipeline/spec";
export { foldPipelineSource, pipelineFindingLine, PIPELINE_FOLD_RULE, PIPELINE_MODULE, type PipelineFinding, type PipelineFold } from "./pipeline/fold";
export { promotionOrderOf, pipelineStage, releaseCutHook, stageHeldAt, stageHeldLine, stageWavesName, stageWavesSpec, type StageHeld } from "./pipeline/stages";
export { gitShowPipeline, promoteBase, readMemberPipeline, readPipelineAt, type PipelineRead, type PipelineShow } from "./pipeline/read";
export { lineDiff, pipelineChange, pipelineChangeSection, pipelineSpecLines, type PipelineChange } from "./pipeline/diff";
export { pipelinePromoteGates, pipelinePromoteSource, promotedDigest, type PipelineGatesOutcome, type PipelinePromoteStop } from "./pipeline/promote";
export {
  checkPipelineFile,
  pipelineFromConfig,
  pipelineSource,
  writePipelineFile,
  type ApprovalRuleConfig,
  type ApprovalRulesConfig,
  type PipelineConfigInput,
  type PipelineEnvironmentConfig,
  type PipelineFileCheck,
  type PipelineSourceOptions,
} from "./pipeline/product";
