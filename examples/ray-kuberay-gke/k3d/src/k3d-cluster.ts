// The smoke-test cluster, declared. `npm run build:k3d-cluster` emits the
// k3d.io/v1alpha5 config that `k3d cluster create --config` consumes, so the
// cluster shape lives here — typed — instead of as CLI flags in
// scripts/k3d-smoke.sh. The name must match the script's $CLUSTER, which
// still drives `k3d image import` and the teardown delete.
import {
  Cluster,
  K3dOptions,
  K3sExtraArg,
  K3sOptions,
  KubeconfigOptions,
  Options,
} from "@intentius/chant-lexicon-k3d";

export const smokeCluster = new Cluster({
  metadata: { name: "ray-kuberay-smoke" },
  servers: 1,
  agents: 0,
  options: new Options({
    k3d: new K3dOptions({ wait: true }),
    k3s: new K3sOptions({
      extraArgs: [
        // No ingress needed — the dashboard is reached via port-forward.
        new K3sExtraArg({ arg: "--disable=traefik", nodeFilters: ["server:*"] }),
        new K3sExtraArg({ arg: "--disable=servicelb", nodeFilters: ["server:*"] }),
        // Ray head + worker fork aggressively at startup; k3s's default
        // pod-max-pids is too low for a laptop-sized RayCluster.
        new K3sExtraArg({ arg: "--kubelet-arg=pod-max-pids=4096", nodeFilters: ["server:*"] }),
      ],
    }),
    // The smoke script drives kubectl and helm against the ambient context
    // right after create, so this cluster opts into k3d's own kubeconfig
    // behaviour — explicitly, because chant's default is the safe false/false.
    kubeconfig: new KubeconfigOptions({
      updateDefaultKubeconfig: true,
      switchCurrentContext: true,
    }),
  }),
});
