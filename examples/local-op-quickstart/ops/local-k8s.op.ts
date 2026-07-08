import { Op, phase, k3dUp, kubectlApply, waitForStack, k3dDown } from "@intentius/chant-lexicon-temporal";

/**
 * Stand up a local vanilla-Kubernetes target with k3d, apply a stack to it, wait
 * for it to roll out, then tear the cluster down — a fully local deploy loop with
 * no cloud account (issue #704).
 *
 * `chant run local-k8s` executes this in-process via the local executor. Requires
 * Docker + the `k3d` and `kubectl` CLIs on PATH. `k3dUp` merges the cluster's
 * kubeconfig and switches context, so the `kubectlApply` step targets it
 * automatically; `k3dUp` is idempotent, so re-runs reuse an existing cluster.
 */
export default Op({
  name: "local-k8s",
  overview: "k3d up → apply → wait → k3d down: a no-account local Kubernetes deploy",
  taskQueue: "local-k8s",
  phases: [
    phase("Cluster", [
      k3dUp("chant-local", { ports: ["8080:80@loadbalancer"] }),
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
