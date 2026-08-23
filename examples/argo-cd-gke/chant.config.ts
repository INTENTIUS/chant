import type { ChantConfig } from "@intentius/chant";

/**
 * Per-deployment values are build-time parameters, not `process.env` reads
 * in `src/`. The `env` mapping keeps exported variables working; the read is
 * declared, validated, and resolved once before any project file loads, so
 * the in-process and sandboxed builds see the same values (chant #1728).
 * `src/chant.config.json` is only a lint-scoping fragment.
 */
export default {
  lexicons: ["k8s"],
  buildParams: {
    // Git source Argo CD watches. Point these at your fork once you've
    // pushed `npm run build` output.
    repo: { type: "string", default: "https://github.com/your-org/argo-cd-gke-demo", env: "ARGO_REPO" },
    appPath: {
      type: "string",
      default: "dist/app",
      env: "ARGO_APP_PATH",
      description: "Path within the repo holding the workload manifests Argo syncs",
    },
    targetRevision: { type: "string", default: "HEAD", env: "ARGO_REVISION" },
    appNamespace: { type: "string", default: "demo", env: "APP_NAMESPACE" },
    // A tiny, public, pinned image so the on-ramp needs no registry.
    appImage: { type: "string", default: "nginxinc/nginx-unprivileged:1.27-alpine", env: "APP_IMAGE" },
  },
} satisfies ChantConfig;
