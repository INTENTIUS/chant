// Shared configuration for the argo-cd-gke example.
//
// This example shows the clean split:
//   Chant authors the workload manifests (src/app) → committed to git.
//   Argo CD reconciles them, driven by an Application Chant also authors
//   (src/bootstrap) and you apply once to bootstrap the GitOps loop.

export const config = {
  // ── Git source Argo CD watches ──────────────────────────────────────────
  // The repo + path where the built workload manifests (dist/app/) live.
  // Point these at your fork once you've pushed `npm run build` output.
  repo: process.env.ARGO_REPO ?? "https://github.com/your-org/argo-cd-gke-demo",
  // Path within the repo holding the workload manifests Argo syncs.
  appPath: process.env.ARGO_APP_PATH ?? "dist/app",
  targetRevision: process.env.ARGO_REVISION ?? "HEAD",

  // ── Where the workload lands ────────────────────────────────────────────
  // Single GKE cluster — Argo runs in it and deploys in-cluster.
  destinationServer: "https://kubernetes.default.svc",
  appNamespace: process.env.APP_NAMESPACE ?? "demo",

  // ── The demo workload ───────────────────────────────────────────────────
  appName: "web",
  // A tiny, public, pinned image so the on-ramp needs no registry.
  appImage: process.env.APP_IMAGE ?? "nginxinc/nginx-unprivileged:1.27-alpine",
  appPort: 8080,
} as const;
