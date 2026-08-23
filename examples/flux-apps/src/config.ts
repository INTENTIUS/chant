// Shared configuration for the flux-apps example.
//
// This example shows the clean split on a self-hosted cluster:
//   Chant authors the workload manifests (src/platform, src/apps) → committed
//   to git. Flux reconciles them, driven by a GitRepository + Kustomizations
//   Chant also authors (src/flux) and you apply once to bootstrap the loop.
//
// Per-deployment values are declared in ../chant.config.ts's buildParams.
// Supply with --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  // ── Git source Flux watches ─────────────────────────────────────────────
  // The repo + branch where the built manifests (dist/) live.
  repo: params.repo as string,
  branch: params.branch as string,

  // ── Where the workloads land ────────────────────────────────────────────
  appNamespace: params.appNamespace as string,

  // ── The demo workloads ──────────────────────────────────────────────────
  webName: "web",
  webImage: params.webImage as string,
  webPort: 8080,
  apiName: "api",
  apiImage: params.apiImage as string,
  apiPort: 8080,

  // ── Ingress ─────────────────────────────────────────────────────────────
  // k3s ships Traefik, so the web app fronts itself with an IngressRoute.
  host: params.host as string,
  issuerName: "selfsigned",
  tlsSecretName: "web-tls",
} as const;
