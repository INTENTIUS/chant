// cert-manager deployment for TLS certificate management.
// In production, install via Helm chart for CRDs and webhooks.

import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

const labels = {
  "app.kubernetes.io/name": "cert-manager",
  "app.kubernetes.io/part-of": "system",
  "app.kubernetes.io/managed-by": "chant",
};

export const certManager = new Deployment({
  metadata: { name: "cert-manager", namespace: "system", labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "cert-manager" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "cert-manager" } },
      spec: {
        containers: [{
          name: "cert-manager",
          image: "quay.io/jetstack/cert-manager-controller:v1.14.4",
          ports: [{ containerPort: 9402, name: "http-metrics" }],
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "256Mi" },
          },
        }],
      },
    },
  },
});

export const certManagerSvc = new Service({
  metadata: { name: "cert-manager", namespace: "system", labels },
  spec: {
    selector: { "app.kubernetes.io/name": "cert-manager" },
    ports: [{ port: 9402, targetPort: 9402, name: "http-metrics" }],
    type: "ClusterIP",
  },
});
