/**
 * k8s Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `k8s` lexicon. Relocated from the temporal lexicon
 * (#809) so Kubernetes-facing imperative activities live with their product:
 *   - kubectlApply — server-side apply a rendered manifest (and, since chant
 *     #1075, prune chant-owned objects it no longer declares; `applyManifest`
 *     is the same work with a report of what it did, which is what the
 *     Temporal lexicon's `nativeApply` dispatcher calls for a kubectl target)
 *   - waitForArgoSync — block until an Argo CD Application is Healthy && Synced
 *
 * k3dUp / k3dDown moved again, to the k3d lexicon (chant #1410) — a lexicon
 * owns its own product's activities, and k3d is its own product now. Projects
 * using them list `k3d` in `lexicons`; loadActivities(["k3d"]) provides them.
 *
 * The step builders (kubectlApply, k3dUp, k3dDown) stay in core, re-exported from
 * the temporal Op-authoring barrel like the other core builders. Each activity is
 * dependency-light — it shells out to a CLI and does not import the k8s declarable
 * surface — so a Temporal worker loads it cheaply.
 */
export { kubectlApply, applyManifest, readManifestDocuments } from "./kubectl";
export type { KubectlApplyArgs, ApplyManifestResult, AppliedRef, ApplyDeleteMode } from "./kubectl";

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
