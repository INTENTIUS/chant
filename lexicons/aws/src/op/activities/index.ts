/**
 * AWS Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `aws` lexicon. Contributes the local Floci AWS
 * emulator lifecycle (`flociUp`/`flociDown`) and the native CloudFormation
 * applier (`awsApply`), which calls the CloudFormation API directly rather than
 * shelling `aws` — the direct twin of `azApply`/`gcpApply`.
 */
export {
  flociUp,
  flociDown,
  flociRunCommand,
  flociRmCommand,
  flociExistsCommand,
  flociHealthUrl,
  flociEnv,
  isFlociReady,
} from "./floci";
export type { FlociUpArgs, FlociDownArgs } from "./floci";

export {
  awsApply,
  awsDelete,
  waitForStackSettled,
  cfnUrl,
  cfnForm,
  capabilityParams,
  xmlField,
  stackStatus,
  stackId,
  cfnErrorMessage,
  isStackMissing,
  isNoUpdates,
  isSuccessStatus,
  isFailureStatus,
  isTerminalStatus,
} from "./aws-apply";
export type { AwsApplyArgs, AwsHttp } from "./aws-apply";
