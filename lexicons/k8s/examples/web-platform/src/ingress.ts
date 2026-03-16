// SecureIngress: TLS ingress with cert-manager (Ingress only — Certificate is a CRD).

import { SecureIngress } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "web-platform";

const ingress = SecureIngress({
  name: "web-platform",
  namespace: NAMESPACE,
  ingressClassName: "nginx",
  clusterIssuer: "letsencrypt-prod",
  hosts: [{
    hostname: "app.example.com",
    paths: [
      { path: "/", serviceName: "frontend", servicePort: 80 },
      { path: "/api", serviceName: "api", servicePort: 80 },
    ],
  }],
  annotations: { "nginx.ingress.kubernetes.io/ssl-redirect": "true" },
});

// Only export the Ingress — Certificate is a CRD not in the k8s lexicon index
export const webIngress = ingress.ingress;
