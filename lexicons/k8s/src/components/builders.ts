/**
 * Typed step-builders for the k8s lexicon's verbs — the same ergonomic sugar
 * the aws lexicon's `components/builders.ts` offers (#658), reusing the
 * exported `step` projection from `@intentius/chant/components`.
 *
 * `kubectl-apply` is a `needs-opt-out` capability (a server-side apply keeps
 * no previous object state, so there is nothing native to roll back to), which
 * means COMP003 requires every step of it to carry a `noRollback: "<reason>"`,
 * a component-level `rollback` phase, or a sibling safety step. The builder
 * admits `noRollback` directly so the common opt-out reads as one typed call
 * instead of a raw object literal.
 */

import { step } from "@intentius/chant/components";
import type { KubectlApplyInput } from "./kubectl-apply";
import type { KustomizeApplyInput } from "./kustomize-apply";
import type { ArgoAppInput } from "./argo-app";
import type { FluxReconcileInput } from "./flux-reconcile";

export const kubectlApply = step<KubectlApplyInput & { noRollback?: string }>("kubectl-apply");

// Same needs-opt-out posture, same sugar (#1548): a kustomize render in front
// of the identical server-side apply.
export const kustomizeApply = step<KustomizeApplyInput & { noRollback?: string }>("kustomize-apply");

// GitOps verbs (#1549 piece 2): the identical server-side apply of the
// controller's CR, then a convergence wait — Healthy+Synced for Argo, the
// Flux readiness registry (Ready, terminal on wedge reasons) for Flux.
export const argoApp = step<ArgoAppInput & { noRollback?: string }>("argo-app");
export const fluxReconcile = step<FluxReconcileInput & { noRollback?: string }>("flux-reconcile");
