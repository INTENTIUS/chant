// The web workload — plain Chant k8s, no Flux anywhere.
//
// Fronted by a Traefik IngressRoute (k3s ships Traefik) with a cert-manager
// Certificate off the platform layer's self-signed ClusterIssuer. `npm run
// build:web` renders it to dist/apps/web/, which you commit to the repo Flux
// watches. The `web` Kustomization (src/flux) reconciles it.

import { WebApp, IngressRoute, Certificate } from "@intentius/chant-lexicon-k8s";
import { config } from "../../config";

const { deployment, service } = WebApp({
  name: config.webName,
  image: config.webImage,
  port: config.webPort,
  namespace: config.appNamespace,
  replicas: 2,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "128Mi",
  securityContext: {
    // nginx-unprivileged runs as uid 101.
    runAsNonRoot: true,
    runAsUser: 101,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  labels: { "app.kubernetes.io/part-of": "flux-apps-demo" },
});

// TLS material for the route, issued by the platform layer's ClusterIssuer.
export const certificate = new Certificate({
  metadata: {
    name: config.tlsSecretName,
    namespace: config.appNamespace,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    secretName: config.tlsSecretName,
    dnsNames: [config.host],
    issuerRef: { kind: "ClusterIssuer", name: config.issuerName },
  },
});

// Traefik IngressRoute instead of a vanilla Ingress — the typed
// K8s::Traefik::IngressRoute class, no CRD escape hatch needed.
export const route = new IngressRoute({
  metadata: {
    name: config.webName,
    namespace: config.appNamespace,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `Host(\`${config.host}\`)`,
        kind: "Rule",
        services: [{ name: config.webName, port: config.webPort }],
      },
    ],
    tls: { secretName: config.tlsSecretName },
  },
});

export { deployment, service };
