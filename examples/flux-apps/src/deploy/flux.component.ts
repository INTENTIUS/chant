/**
 * The deploy leaf for the Flux bootstrap (#1607): apply dist/flux.yaml
 * through the same server-side apply kubectl-apply uses, then block until
 * every applied Flux CR reports Ready — sources first, so a wedged clone
 * surfaces as the GitRepository's error rather than a reconciler timeout
 * downstream of it.
 *
 * `stack: "flux-apps"` matches the project's `ownership.stack`, so the
 * apply's field manager and the labels the build stamps name the same owner
 * — and `chant components status --live` observes this unit through the k8s
 * lexicon's label-selector read.
 *
 * `kubectl apply -f dist/flux.yaml` (npm run bootstrap) does the same apply
 * without the convergence wait — fine for a first manual bootstrap.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { fluxReconcile } from "@intentius/chant-lexicon-k8s/components";

export const fluxBootstrap: Component = {
  name: "flux-bootstrap",
  archetype: "service",
  dependsOn: [],
  liveNames: ["source", "platform", "api", "web"],
  deploy: [
    phase("Reconcile", [
      fluxReconcile({
        manifest: "dist/flux.yaml",
        stack: "flux-apps",
        noRollback:
          "server-side apply keeps no previous object state; the declared source is the restore path (rebuild + re-apply, and Flux reconciles forward)",
      }),
    ]),
  ],
};
