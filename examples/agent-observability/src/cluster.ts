/**
 * The local cluster: one server and one agent node, so the collector agent
 * DaemonSet runs twice and traces cross nodes on their way to the gateway.
 * k3s's bundled Traefik is turned off: nothing here takes ingress, and it
 * would be one more image to pull. The kubelet's disk-pressure eviction
 * thresholds are absolute rather than the default percentages: a laptop's
 * Docker disk that is 90% full can still hold this stack, and the default
 * `imagefs.available<15%` would evict every pod on it. `chant build --lexicon k3d` writes the
 * config `k3d cluster create --config` reads; the e2e brings it up with the
 * k3d lexicon's `k3dUp`.
 */
import { Cluster, K3dOptions, K3sExtraArg, K3sOptions, Options } from "@intentius/chant-lexicon-k3d";

export const K3S_IMAGE = "rancher/k3s:v1.33.6-k3s1";

const clusterMetadata = { name: "agent-observability" };
const noLoadbalancer = new K3dOptions({ disableLoadbalancer: true });
const noTraefik = new K3sExtraArg({ arg: "--disable=traefik", nodeFilters: ["server:*"] });
const everyNode = ["server:*", "agent:*"];
const evictionHard = new K3sExtraArg({
  arg: "--kubelet-arg=eviction-hard=imagefs.available<1Gi,nodefs.available<1Gi",
  nodeFilters: everyNode,
});
const evictionReclaim = new K3sExtraArg({
  arg: "--kubelet-arg=eviction-minimum-reclaim=imagefs.available=100Mi,nodefs.available=100Mi",
  nodeFilters: everyNode,
});
const k3sArgs = new K3sOptions({ extraArgs: [noTraefik, evictionHard, evictionReclaim] });
const clusterOptions = new Options({ k3d: noLoadbalancer, k3s: k3sArgs });

const cluster = new Cluster({
  metadata: clusterMetadata,
  image: K3S_IMAGE,
  servers: 1,
  agents: 1,
  options: clusterOptions,
});

export { cluster };
