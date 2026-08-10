import type { ChantConfig } from "@intentius/chant";

/**
 * `ownership` makes the labels channel work: the build stamps
 * `chant.intentius.io/stack: flux-apps` (plus managed-by and env) on every
 * resource, Flux applies the manifests, and `chant components status --live`
 * reads the workloads back through exactly that label selector. Attribution
 * survives regardless of who did the applying — Flux prunes by its own
 * labels, chant observes by its own, neither needs the other's.
 *
 * The `home` profile binds the k3s cluster's kubeconfig context (k3s names
 * it `default`). Without the binding an unrelated `kubectl config
 * use-context` would turn a live read into a confident report about the
 * wrong cluster.
 */
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: [{ name: "home" }],
  ownership: { stack: "flux-apps", env: "home" },
  k8s: { profiles: { home: { context: "default" } } },
} satisfies ChantConfig;
