// Shared configuration for the flux-apps example.
//
// This example shows the clean split on a self-hosted cluster:
//   Chant authors the workload manifests (src/platform, src/apps) → committed
//   to git. Flux reconciles them, driven by a GitRepository + Kustomizations
//   Chant also authors (src/flux) and you apply once to bootstrap the loop.

export const config = {
  // ── Git source Flux watches ─────────────────────────────────────────────
  // The repo + branch where the built manifests (dist/) live. Point these at
  // your fork once you've pushed `npm run build` output.
  repo: process.env.FLUX_REPO ?? "https://github.com/your-org/flux-apps-demo",
  branch: process.env.FLUX_BRANCH ?? "main",

  // ── Where the workloads land ────────────────────────────────────────────
  appNamespace: process.env.APP_NAMESPACE ?? "demo",

  // ── The demo workloads ──────────────────────────────────────────────────
  // Tiny, public, pinned images so the on-ramp needs no registry.
  webName: "web",
  webImage: process.env.WEB_IMAGE ?? "nginxinc/nginx-unprivileged:1.27-alpine",
  webPort: 8080,
  apiName: "api",
  apiImage: process.env.API_IMAGE ?? "traefik/whoami:v1.10.3",
  apiPort: 8080,

  // ── Ingress ─────────────────────────────────────────────────────────────
  // k3s ships Traefik, so the web app fronts itself with an IngressRoute.
  host: process.env.APP_HOST ?? "web.home.example",
  issuerName: "selfsigned",
  tlsSecretName: "web-tls",
} as const;
