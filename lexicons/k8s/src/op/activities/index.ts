/**
 * k8s Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `k8s` lexicon. Relocated from the hosting lexicon
 * (#809) so Kubernetes-facing imperative activities live with their product:
 *   - kubectlApply — server-side apply a rendered manifest (and, since chant
 *     #1075, prune chant-owned objects it no longer declares; `applyManifest`
 *     is the same work with a report of what it did, which is what core's
 *     `nativeApply` dispatcher calls for a kubectl target)
 *   - waitForArgoSync — block until an Argo CD Application is Healthy && Synced
 *
 * k3dUp / k3dDown moved again, to the k3d lexicon (chant #1410) — a lexicon
 * owns its own product's activities, and k3d is its own product now. Projects
 * using them list `k3d` in `lexicons`; loadActivities(["k3d"]) provides them.
 *
 * The step builders (kubectlApply, k3dUp, k3dDown) stay in core and reach
 * authors through `@intentius/chant/op` like the other core builders. Each
 * activity is dependency-light — it shells out to a CLI and does not import the
 * k8s declarable surface — so `loadActivities`
 * (`packages/core/src/op/activity-registry.ts`), which imports this module at
 * run time, pulls in nothing expensive.
 */
export { kubectlApply, applyManifest, readManifestDocuments } from "./kubectl";
export type { KubectlApplyArgs, ApplyManifestResult, AppliedRef, ApplyDeleteMode } from "./kubectl";

// Generated-once secret materialization (#1830) — the activity behind core's
// `ensureSecret(...)` step builder (#1829). Read-then-write over the
// namespace-scoped store adapter in ../../secret-store.ts; no output carries
// secret material.
export { ensureSecret } from "./ensure-secret";
export type { EnsureSecretActivityArgs } from "./ensure-secret";

export { waitForArgoSync, defaultArgoStatusFetcher, ArgoSyncFailedError } from "./argo";
export type { WaitForArgoSyncArgs, ArgoAppStatus, ArgoStatusFetcher } from "./argo";

export {
  waitForReady,
  defaultResourceFetcher,
  apiResourceFetcher,
  ReadinessFailedError,
  readinessFor,
  isReady,
  firstTerminal,
  DEFAULT_READINESS,
  READINESS_OVERRIDES,
} from "./wait-for-ready";
export type {
  WaitForReadyArgs,
  ResourceFetcher,
  ReadinessSpec,
  ReadinessMatch,
  ConditionMatch,
  PathMatch,
} from "./wait-for-ready";

// Environment→cluster binding (chant #1100) — the same resolver
// `describeResources` (the read path) uses. `kubectlApply` and `waitForReady`
// above already accept an optional `context`; a workflow author who wants the
// write path to target the environment's bound cluster (rather than an
// ambient one, closing the read/write split) resolves it here and passes the
// result through, e.g. `kubectlApply({ manifest, context: (await
// resolveClusterTarget(config, environment, "k8s")).context })`. Re-exported
// from core rather than duplicated so both paths agree on one source of
// truth — see `lexicons/k8s/src/config.ts` for the config shape.
export { resolveClusterTarget, ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
export type { ResolvedClusterTarget, K8sClusterProfile, K8sConfigShape } from "@intentius/chant/kubectl-context";

// Effect-receipt activities (#2074): core's receipt seam (#1834) bound to
// this lexicon's ConfigMap-backed store (../../receipt-store.ts), the same
// way the aws lexicon binds its SSM store (#1835). Re-exported individually:
// `receiptRead`/`receiptWrite` serve the `effect()` step's
// read-compare-run-write, `receiptStaleness` serves WatchOp's read-only
// staleness reporting.
import { receiptActivities } from "@intentius/chant/op/receipt-store";
import { k8sReceiptStore } from "../../receipt-store";

const boundReceiptActivities = receiptActivities(k8sReceiptStore());
export const receiptRead = boundReceiptActivities.receiptRead;
export const receiptWrite = boundReceiptActivities.receiptWrite;
export const receiptStaleness = boundReceiptActivities.receiptStaleness;
