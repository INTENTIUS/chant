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

  // Per-deployment values are build-time parameters, not `process.env` reads
  // in `src/`. The `env` mapping keeps exported variables working; the read
  // is declared, validated, and resolved once before any project file loads,
  // so the in-process and sandboxed builds see the same values (chant #1728).
  buildParams: {
    // Git source Flux watches. Point these at your fork once you've pushed
    // `npm run build` output.
    repo: { type: "string", default: "https://github.com/your-org/flux-apps-demo", env: "FLUX_REPO" },
    branch: { type: "string", default: "main", env: "FLUX_BRANCH" },
    appNamespace: { type: "string", default: "demo", env: "APP_NAMESPACE" },
    // Tiny, public, pinned images so the on-ramp needs no registry.
    webImage: { type: "string", default: "nginxinc/nginx-unprivileged:1.27-alpine", env: "WEB_IMAGE" },
    apiImage: { type: "string", default: "traefik/whoami:v1.10.3", env: "API_IMAGE" },
    host: { type: "string", default: "web.home.example", env: "APP_HOST" },
  },
} satisfies ChantConfig;
