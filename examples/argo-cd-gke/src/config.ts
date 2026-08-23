// Shared configuration for the argo-cd-gke example.
//
// This example shows the clean split:
//   Chant authors the workload manifests (src/app) → committed to git.
//   Argo CD reconciles them, driven by an Application Chant also authors
//   (src/bootstrap) and you apply once to bootstrap the GitOps loop.
//
// Per-deployment values are declared in ../chant.config.ts's buildParams.
// Supply with --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  // ── Git source Argo CD watches ──────────────────────────────────────────
  // The repo + path where the built workload manifests (dist/app/) live.
  repo: params.repo as string,
  // Path within the repo holding the workload manifests Argo syncs.
  appPath: params.appPath as string,
  targetRevision: params.targetRevision as string,

  // ── Where the workload lands ────────────────────────────────────────────
  // Single GKE cluster — Argo runs in it and deploys in-cluster.
  destinationServer: "https://kubernetes.default.svc",
  appNamespace: params.appNamespace as string,

  // ── The demo workload ───────────────────────────────────────────────────
  appName: "web",
  appImage: params.appImage as string,
  appPort: 8080,
} as const;
