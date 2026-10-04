/**
 * Pin-bump rollouts (#3189): the pin edit, the wave plan, and the run that
 * opens one pull request per wave.
 *
 * This subpath, `@intentius/chant-lexicon-terraform/pin`, bundles without the
 * TypeScript toolchain, zod, or chant's fold, lint and codegen modules, so
 * terragucci's `tf-rollout` stage can run it from one bundled file (#3421).
 * `./bundle.test.ts` holds it to that. The HCL parser is passed in, and the
 * TypeScript editor for generated roots lives in `./edit-ts.ts`, which this
 * index does not import.
 */

export { readModulePin, movePin, moduleOf, exactVersion, isPinValue, checkPinRequest } from "./source";
export type { ModuleCallPin, PinMove, PinParam } from "./source";
export { editPins, isTerragruntFile } from "./edit";
export type { PinRequest, PinCallResult, PinEditResult } from "./edit";
export { planPinWaves, wavesFromChoudoufu, restrictWaves, terragruntDependencies, PinWavePlanError } from "./waves";
export type { PinRoot, PinWave } from "./waves";
export { ghPinForge } from "./forge";
export type { PinForge, PinPullRequest, PinCommitCheck } from "./forge";
export { runPinRollout, renderPinRollout, pinWaveBranch } from "./rollout";
export type { PinRolloutOptions, PinRolloutResult, PinRolloutMode, PinRootState, PinWaveState, PinWaveStatus, TsPinEditor } from "./rollout";
