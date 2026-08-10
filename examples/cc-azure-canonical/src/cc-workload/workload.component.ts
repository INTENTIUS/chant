/**
 * The release half for the k8s substrate (#1495): the workload component that
 * `kubectl-apply`s the built manifest. The azure half has no component
 * counterpart — floci-az has no deployments provider, so the ARM estate is
 * applied per-resource by the `cc-azure-deploy` Op (`../../ops/deploy.op.ts`) — which
 * is itself the honest shape of the azure lane (#1200).
 *
 * The two applies have a real-world gap between them: the k8s half needs the
 * AKS cluster Succeeded and its admin kubeconfig extracted, which happens
 * after the ARM apply completes. The e2e (`test/azure-cc-e2e.sh`) runs them
 * in that order with the kubeconfig step in between.
 *
 * `stack: "cc-azure-canonical"` matches the project's `ownership.stack`, so
 * the apply's field manager (`chant:cc-azure-canonical`) and the labels the
 * build stamps name the same owner — and `chant components status --live`
 * observes this unit through the k8s lexicon's `describeStackStatus`, which
 * selects on exactly that label.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { kubectlApply } from "@intentius/chant-lexicon-k8s/components";

export const workload: Component = {
  name: "cc-workload",
  archetype: "service",
  dependsOn: [],
  liveNames: ["apiService", "apiDeployment", "apiPdb"],
  deploy: [
    phase("Apply", [
      kubectlApply({
        manifest: "k8s.yaml",
        stack: "cc-azure-canonical",
        noRollback:
          "server-side apply keeps no previous object state; the declared source is the restore path (chant reconcile + re-apply)",
      }),
    ]),
  ],
};
