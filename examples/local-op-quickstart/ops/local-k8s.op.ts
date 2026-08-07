import { Op, phase, k3dUp, kubectlApply, waitForStack, k3dDown } from "@intentius/chant-lexicon-temporal";

/**
 * Stand up a local vanilla-Kubernetes target with k3d, apply a stack to it, wait
 * for it to roll out, then tear the cluster down — a fully local deploy loop with
 * no cloud account (issue #704).
 *
 * `chant run local-k8s` executes this in-process via the local executor. Requires
 * Docker + the `k3d` and `kubectl` CLIs on PATH. By default `k3dUp` leaves your
 * kubeconfig and current context alone (chant #1411); this op opts back into
 * merge-and-switch so the ambient `kubectlApply` step targets the new cluster.
 * `k3dUp` is idempotent, so re-runs reuse an existing cluster.
 */
export default Op({
  name: "local-k8s",
  overview: "k3d up → apply → wait → k3d down: a no-account local Kubernetes deploy",
  taskQueue: "local-k8s",
  phases: [
    phase("Cluster", [
      // Opt into merging the cluster into ~/.kube/config and switching the
      // current context — the following kubectlApply relies on the ambient context.
      k3dUp("chant-local", {
        ports: ["8080:80@loadbalancer"],
        updateDefaultKubeconfig: true,
        switchCurrentContext: true,
      }),
    ]),
    phase("Deploy", [
      kubectlApply("dist/app.yaml"),
    ]),
    phase("Wait", [
      waitForStack("app"),
    ]),
    phase("Teardown", [
      k3dDown("chant-local"),
    ]),
  ],
});
