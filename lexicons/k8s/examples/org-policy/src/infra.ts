// A web app, attributed to a cost center (satisfies ORG-COST-CENTER), exposed
// via an Ingress with NO TLS. That builds fine in dev/staging, but
// ORG-PROD-TLS rejects it under `chant build --env prod`.
import { WebApp } from "@intentius/chant-lexicon-k8s";

const app = WebApp({
  name: "storefront",
  image: "ghcr.io/acme/storefront:1.4.0",
  port: 8080,
  replicas: 2,
  ingressHost: "storefront.acme.example",
  // The cost-center label every workload must carry (org policy).
  labels: { "acme.io/cost-center": "retail-web" },
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
});

export const { deployment, service, ingress } = app;
