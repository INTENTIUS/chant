/**
 * The CC lane's release half for the k8s substrate (#1495): the workload
 * component that `kubectl-apply`s the built manifest, the counterpart of
 * `../cc.component.ts`'s `cfn-deploy`.
 *
 * A second component rather than a second phase on `cc-canonical`, because the
 * two applies have a real-world gap between them: the k8s half needs the EKS
 * cluster ACTIVE and its context in the kubeconfig (`aws eks
 * update-kubeconfig`), which happens after the CloudFormation apply completes.
 * `dependsOn` records the ordering for wave resolution; the e2e runs them
 * separately with the kubeconfig step in between (`test/aws-cc-e2e.sh`).
 *
 * `stack: "cc-aws-canonical"` matches the project's `ownership.stack`, so the
 * apply's field manager (`chant:cc-aws-canonical`) and the labels the build
 * stamps name the same owner — and `chant components status --live` observes
 * this unit through the k8s lexicon's `describeStackStatus`, which selects on
 * exactly that label. Two components, two deploy units, two observers: the
 * status table reports both substrates.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { kubectlApply } from "@intentius/chant-lexicon-k8s/components";

export const workload: Component = {
  name: "cc-workload",
  archetype: "service",
  dependsOn: ["cc-canonical"],
  liveNames: ["apiService", "apiDeployment", "apiPdb"],
  deploy: [
    phase("Apply", [
      kubectlApply({
        manifest: "k8s.yaml",
        stack: "cc-aws-canonical",
        noRollback:
          "server-side apply keeps no previous object state; the declared source is the restore path (chant reconcile + re-apply)",
      }),
    ]),
  ],
};
