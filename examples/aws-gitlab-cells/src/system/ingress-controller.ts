// NGINX ingress controller — routes traffic to cell namespaces.
// Deployed in the system namespace; cells allow ingress only from this controller.

import { Deployment, Service, ServiceAccount } from "@intentius/chant-lexicon-k8s";

const labels = {
  "app.kubernetes.io/name": "ingress-nginx",
  "app.kubernetes.io/part-of": "system",
  "app.kubernetes.io/managed-by": "chant",
};

export const ingressSa = new ServiceAccount({
  metadata: { name: "ingress-nginx-sa", namespace: "system", labels },
});

export const ingressController = new Deployment({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "ingress-nginx" } },
      spec: {
        serviceAccountName: "ingress-nginx-sa",
        containers: [{
          name: "controller",
          image: "registry.k8s.io/ingress-nginx/controller:v1.10.0",
          ports: [
            { containerPort: 80, name: "http" },
            { containerPort: 443, name: "https" },
          ],
          args: [
            "/nginx-ingress-controller",
            "--election-id=ingress-nginx-leader",
            "--controller-class=k8s.io/ingress-nginx",
            "--watch-namespace=",
          ],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 10254 }, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 10254 }, periodSeconds: 10 },
        }],
      },
    },
  },
});

export const ingressService = new Service({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    type: "LoadBalancer",
    selector: { "app.kubernetes.io/name": "ingress-nginx" },
    ports: [
      { port: 80, targetPort: 80, protocol: "TCP", name: "http" },
      { port: 443, targetPort: 443, protocol: "TCP", name: "https" },
    ],
  },
});
