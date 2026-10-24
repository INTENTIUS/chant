/**
 * Typed step-builders for the gcp lexicon's verbs (#3143). `gcpApply({ manifest })`
 * is exactly `{ kind: "gcp-apply", manifest }`, checked against the capability's
 * input. `publishImage` is core's verb; gcp contributes only the Artifact
 * Registry login, chosen by the registry host or `$env.publish.backend`.
 */
import { step } from "@intentius/chant/components";
import type { GcpApplyStepInput } from "./gcp-apply";
import type { WaitForOperationInput, WaitCloudRunReadyInput } from "./wait-gcp";

export const gcpApply = step<GcpApplyStepInput>("gcp-apply");
export const waitForOperation = step<WaitForOperationInput>("wait-for-operation");
export const waitCloudRunReady = step<WaitCloudRunReadyInput>("wait-cloud-run-ready");
