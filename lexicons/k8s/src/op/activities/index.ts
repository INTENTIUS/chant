/**
 * k8s Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `k8s` lexicon. Relocated from the temporal lexicon
 * (#809) so Kubernetes-facing imperative activities live with their product:
 *   - kubectlApply — `kubectl apply` a rendered manifest
 *   - k3dUp / k3dDown — boot/tear down a local k3d cluster
 *   - waitForArgoSync — block until an Argo CD Application is Healthy && Synced
 *
 * The step builders (kubectlApply, k3dUp, k3dDown) stay in core, re-exported from
 * the temporal Op-authoring barrel like the other core builders. Each activity is
 * dependency-light — it shells out to a CLI and does not import the k8s declarable
 * surface — so a Temporal worker loads it cheaply.
 */
export { kubectlApply } from "./kubectl";
export type { KubectlApplyArgs } from "./kubectl";

export { k3dUp, k3dDown, k3dUpCommand, k3dDownCommand, k3dExistsCommand } from "./k3d";
export type { K3dUpArgs, K3dDownArgs } from "./k3d";

export { waitForArgoSync, defaultArgoStatusFetcher, ArgoSyncFailedError } from "./argo";
export type { WaitForArgoSyncArgs, ArgoAppStatus, ArgoStatusFetcher } from "./argo";
