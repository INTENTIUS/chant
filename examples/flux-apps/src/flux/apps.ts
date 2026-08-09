// The Flux bootstrap — one GitRepository and three Kustomizations that point
// Flux at the built manifests in git.
//
// `FluxGitSource` + `FluxAppFor` are the opt-in bridge: the k8s lexicon
// emitted the workloads (src/platform, src/apps) with no knowledge of Flux;
// here we declare, in four calls, that Flux should reconcile them and in
// what order. `npm run build:flux` renders this to dist/flux.yaml, which you
// apply once to start the GitOps loop.
//
// One source, many apps: the repo is declared once and every Kustomization
// reconciles a path out of it. The dependsOn edges are plain name lists —
// FLUX003 validates every entry against the Kustomizations this build
// declares, so a typo fails the build instead of stalling the cluster.

import { FluxGitSource, FluxAppFor } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// The one GitRepository — 5m fetch interval, ref pinned to a branch
// (FLUX001: an unset ref falls back to `master`).
export const source = FluxGitSource("flux-apps", {
  url: config.repo,
  branch: config.branch,
});

// The platform layer: namespace + ClusterIssuer. No dependencies.
export const platform = FluxAppFor("platform", {
  source,
  path: "./dist/platform",
});

// The api workload — lands only after the platform layer is Ready.
export const api = FluxAppFor("api", {
  source,
  path: "./dist/apps/api",
  dependsOn: ["platform"],
});

// The web workload — needs the namespace/issuer (platform) and routes to
// the api, so it reconciles last.
export const web = FluxAppFor("web", {
  source,
  path: "./dist/apps/web",
  dependsOn: ["platform", "api"],
});
