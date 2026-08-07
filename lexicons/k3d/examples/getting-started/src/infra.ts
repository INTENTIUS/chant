/**
 * A local development cluster, declared.
 *
 * `chant build` emits the SimpleConfig YAML that `k3d cluster create
 * --config` consumes verbatim — walk away with the file any time. Unless a
 * declaration says otherwise, the emitted config pins
 * `options.kubeconfig.updateDefaultKubeconfig: false` and
 * `switchCurrentContext: false`: creating this cluster never rewrites
 * ~/.kube/config or repoints your shell. Reach it via the context the
 * `k3dUp` activity reports, or declare the upstream behaviour back on
 * explicitly, as `kubeconfig` below shows.
 */
import { Cluster, K3dOptions, KubeconfigOptions, Options, Port } from "@intentius/chant-lexicon-k3d";

/** One server, no agents, no loadbalancer — the ordinary laptop shape. */
export const devCluster = new Cluster({
  metadata: { name: "chant-dev" },
  servers: 1,
  agents: 0,
  options: new Options({
    k3d: new K3dOptions({ disableLoadbalancer: true }),
  }),
});

/**
 * A cluster that opts back into k3d's own kubeconfig behaviour and exposes
 * the loadbalancer on a host port — closer to upstream's quickstart.
 */
export const integrationCluster = new Cluster({
  metadata: { name: "chant-integration" },
  servers: 1,
  agents: 2,
  ports: [new Port({ port: "8080:80", nodeFilters: ["loadbalancer"] })],
  options: new Options({
    kubeconfig: new KubeconfigOptions({
      updateDefaultKubeconfig: true,
      switchCurrentContext: true,
    }),
  }),
});
