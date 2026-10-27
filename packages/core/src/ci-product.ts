/**
 * `@intentius/chant/ci-product` (#4550): what a CI product built on chant's
 * pull request pipeline imports. terragucci and plywood pass their words
 * here and get the same jobs, the same note and the same statuses, in their
 * own words.
 *
 * A product feature-detects this entry until the chant release that carries
 * {@link CI_PRODUCT_FLOOR} is its floor: `productPipelineJobs`, `approveLine`
 * and `assertProductWords` present means the rest is too.
 */

import { NEXT_RELEASE } from "./release-floors";
import type { CiProductWords, CiProductWordsInput } from "./ci-product-words";
import type { ProductMcpHook } from "./cli/mcp/product-tools";
import { OTLP_EXPORTER_FLOOR } from "./otlp";

/**
 * The first chant with the product pipeline (#4550): the words, the
 * `pull-request` op-wave approval source, `runCommandInProcess(argv, {
 * words })`, the lexicons' `ciSetup`, and the member detail sections of the
 * note (#4573).
 */
export const CI_PRODUCT_FLOOR = NEXT_RELEASE;

export {
  activeProductWords,
  approveLine,
  assertProductWords,
  CHANT_APPROVE_TEMPLATE,
  CHANT_OVERRIDE_TEMPLATE,
  CHANT_WORDS,
  CI_PRODUCT_COMMANDS,
  CI_PRODUCT_STAGES,
  CiProductWordsError,
  commandWord,
  commentLine,
  isChantWords,
  overrideLine,
  parseProductComment,
  productContext,
  productStatusContext,
  productWaveGate,
  productWordsProblems,
  resolveProductWords,
  setActiveProductWords,
  withProductWords,
  type ApproveLineInput,
  type CiProductAlias,
  type CiProductApproval,
  type CiProductCommand,
  type CiProductStage,
  type CiProductWords,
  type CiProductWordsInput,
  type OverrideLineInput,
  type ParsedProductComment,
} from "./ci-product-words";
export {
  componentWavesSpec,
  productCommand,
  productPipelineJobs,
  productWavesSpec,
  productWavesSpecFile,
  PRODUCT_WAVES_SPEC_DIR,
  type ComponentWaveSteps,
  type ProductPipelineJobs,
  type ProductPipelineOptions,
} from "./components/product-pipeline";
export { prApplyComment, prLoopSetup, engineSetupLines, withProductBin } from "./components/pr-pipeline";
export { renderPrNote, prStatusContext, prApproveCommand, type PrMemberDetail } from "./pr-loop";
export { upsertPlanNote } from "./pr-post";

/**
 * Run one chant command line in this process with the product's words
 * (ruling C): what a product's bin calls for every command its verbs map
 * onto, and for the `chant ...` lines the generated jobs run through it. The
 * CLI loads on the first call, so importing this entry stays light.
 */
export async function runChantInProcess(argv: string[], words: CiProductWordsInput | CiProductWords, options: { mcp?: ProductMcpHook } = {}): Promise<number> {
  const { runCommandInProcess } = await import("./cli/main");
  return runCommandInProcess(argv, { words, ...(options.mcp ? { mcp: options.mcp } : {}) });
}

/**
 * Telemetry and MCP (#4555). A product's bin configures the exporter once
 * with its prefix (`configureOtlp({ prefix })`, or leaves it to its words),
 * and passes its MCP tools as `runChantInProcess(["serve", "mcp"], words, {
 * mcp: hook })`. Feature-detect on `configureOtlp` and
 * `PRODUCT_MCP_HOOK_FLOOR`: present means both are.
 */
export const PRODUCT_MCP_HOOK_FLOOR = OTLP_EXPORTER_FLOOR;
export type { ProductMcpContext, ProductMcpHook } from "./cli/mcp/product-tools";
export {
  activeOtlp,
  configureOtlp,
  OTLP_EXPORTER_FLOOR,
  RunEventTrace,
  type CapabilityTraceFacts,
  type CapabilityTraceSpan,
  type OtlpExporter,
} from "./otlp";
