// The api workload — plain Chant k8s, no Flux anywhere.
//
// `npm run build:api` renders it to dist/apps/api/, which you commit to the
// repo Flux watches. The `api` Kustomization (src/flux) reconciles it.

import { WebApp } from "@intentius/chant-lexicon-k8s";
import { config } from "../../config";

const { deployment, service } = WebApp({
  name: config.apiName,
  image: config.apiImage,
  port: config.apiPort,
  namespace: config.appNamespace,
  replicas: 2,
  // whoami binds :80 as root by default; WHOAMI_PORT_NUMBER moves it above
  // 1024 so the restricted security context holds.
  env: [{ name: "WHOAMI_PORT_NUMBER", value: String(config.apiPort) }],
  cpuRequest: "25m",
  memoryRequest: "32Mi",
  cpuLimit: "100m",
  memoryLimit: "64Mi",
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 65532,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  labels: { "app.kubernetes.io/part-of": "flux-apps-demo" },
});

export { deployment, service };
