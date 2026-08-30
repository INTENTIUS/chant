/**
 * AWS Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `aws` lexicon. Contributes the local Floci AWS
 * emulator lifecycle (`flociUp`/`flociDown`) and the native CloudFormation
 * applier (`awsApply`, with `awsDelete` and the `rollbackStack` compensation),
 * which calls the CloudFormation API directly rather than shelling `aws` — the
 * direct twin of `azApply`/`gcpApply`.
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
  rollbackStack,
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
export type { AwsApplyArgs, RollbackStackArgs, AwsHttp } from "./aws-apply";

// Effect-receipt activities (#1835) — core's receipt seam (#1834) bound to
// the SSM store, the way the k8s lexicon binds `ensureSecret` (#1830). The
// registry keys exported functions by name, so the three bound activities are
// re-exported individually: `receiptRead`/`receiptWrite` serve the `effect()`
// step's read-compare-run-write, `receiptStaleness` serves WatchOp's
// read-only phase. The store resolves its path identity and endpoint lazily
// at first use, so this module stays cheap to load.
import { receiptActivities } from "@intentius/chant/op/receipt-store";
import { awsReceiptStore } from "../../receipt-store";

const boundReceiptActivities = receiptActivities(awsReceiptStore());
export const receiptRead = boundReceiptActivities.receiptRead;
export const receiptWrite = boundReceiptActivities.receiptWrite;
export const receiptStaleness = boundReceiptActivities.receiptStaleness;

export { awsAgentCoreFetchTrace } from "../../agentcore/trace-fetch";
export type {
  AgentCoreTraceSource,
  AwsAgentCoreFetchTraceArgs,
  AwsAgentCoreFetchTraceResult,
} from "../../agentcore/trace-fetch";
