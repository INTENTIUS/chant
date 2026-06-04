// The demo workload Argo CD manages.
//
// This is plain Chant-authored k8s — the lexicon stays runtime-agnostic. It
// knows nothing about Argo. `npm run build:app` renders it to dist/app/, which
// you commit to the repo Argo watches. Argo reconciles it; Chant never applies
// it directly.

import { WebApp } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const { deployment, service } = WebApp({
  name: config.appName,
  image: config.appImage,
  port: config.appPort,
  namespace: config.appNamespace,
  replicas: 2,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "128Mi",
  securityContext: {
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  labels: { "app.kubernetes.io/part-of": "argo-cd-gke-demo" },
});

export { deployment, service };
