/**
 * Connecting to a cluster on `chant kube`'s behalf (chant #1079), honoring
 * the exact same environment→cluster binding every other observing path
 * does (chant #1100/#1155): `--env` resolves `k8s.profiles.<env>.context`
 * and refuses loudly on a mismatch, `--context` is an explicit override that
 * skips the binding entirely, and neither given falls back to the ambient
 * kubeconfig context — the same three modes `describeResources` and the Op
 * activities already use, via the same `defaultK8sConnector`. Nothing here
 * reimplements that resolution; this only turns a connect failure into the
 * observation tri-state so a verb can render NOT-OBSERVED-with-reason
 * instead of a stack trace.
 */

import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import type { UnobservedReason } from "@intentius/chant/observation";
import { defaultK8sConnector, type ConnectOptions, type ConnectedClient, type K8sConnector } from "../api/connect";
import { classifyApiFailure, isMissingClientPackage, isWholeLexiconFailure, MISSING_CLIENT_DETAIL } from "../api/classify";

export type KubeConnectResult =
  | ({ kind: "connected" } & ConnectedClient)
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

/**
 * Connect, or classify the failure into the tri-state. A bound-but-mismatched
 * `--env` (`ClusterBindingMismatchError`), a missing `@intentius/chant-k8s-client`
 * install, and a refused exec-credential plugin are the "nothing left the
 * process" failures every verb must treat identically: NOT-OBSERVED, never
 * an empty/absent result.
 */
export async function kubeConnect(
  options: ConnectOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<KubeConnectResult> {
  try {
    const connected = await connect(options);
    return { kind: "connected", ...connected };
  } catch (err) {
    if (isMissingClientPackage(err)) {
      return { kind: "unobserved", reason: "read-failed", detail: MISSING_CLIENT_DETAIL };
    }
    if (err instanceof ClusterBindingMismatchError) {
      return { kind: "unobserved", reason: "no-binding", detail: err.message };
    }
    if (isWholeLexiconFailure(err)) {
      const outcome = classifyApiFailure(err);
      return {
        kind: "unobserved",
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      };
    }
    throw err;
  }
}
