// The Argo CD bootstrap — one Application that points Argo at the workload
// manifests in git.
//
// `ArgoAppFor` is the opt-in bridge: the k8s lexicon emitted the workload
// (src/app) with no knowledge of Argo; here we declare, in one call, that Argo
// should reconcile it. `npm run build:bootstrap` renders this to dist/argo.yaml,
// which you apply once to start the GitOps loop.

import { ArgoAppFor } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

export const web = ArgoAppFor(config.appName, {
  repo: config.repo,
  path: config.appPath,
  targetRevision: config.targetRevision,
  destination: { server: config.destinationServer, namespace: config.appNamespace },
  // Defaults to the built-in `default` project and automated, non-pruning,
  // self-healing sync with CreateNamespace=true — exactly what a first on-ramp
  // wants. Override `project` / `syncPolicy` as the deployment hardens.
});
