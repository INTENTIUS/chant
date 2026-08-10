/**
 * AWS Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `aws` lexicon. Contributes the local Floci AWS
 * emulator lifecycle (`flociUp`/`flociDown`) and the native CloudFormation
 * applier (`awsApply`), which calls the CloudFormation API directly rather than
 * shelling `aws` — the direct twin of `azApply`/`gcpApply`.
 *
 * The registry keys every exported *function* here by its name, so only the
 * activities themselves belong in this barrel. `awsAgentCoreFetchTrace`'s
 * helpers — the normalizer, the JSON coercion, the `ListEvents` walk — stay
 * importable from `@intentius/chant-lexicon-aws/agentcore/trace-fetch` rather
 * than being registered as activities nobody would ever name in a step, and the
 * pure renderer lives one module further out again, in
 * `@intentius/chant-lexicon-aws/agentcore/trace-render`.
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

export { awsAgentCoreFetchTrace } from "../../agentcore/trace-fetch";
export type {
  AgentCoreTraceSource,
  AwsAgentCoreFetchTraceArgs,
  AwsAgentCoreFetchTraceResult,
} from "../../agentcore/trace-fetch";
