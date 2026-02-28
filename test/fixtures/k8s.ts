import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
export const deployment = new Deployment({
  metadata: { name: "smoke-app", labels: { "app.kubernetes.io/name": "smoke-app" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "smoke-app" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "smoke-app" } },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "smoke-app:latest",
            ports: [{ containerPort: 8080, name: "http" }],
            livenessProbe: new Probe({ httpGet: { path: "/healthz", port: 8080 } }),
            readinessProbe: new Probe({ httpGet: { path: "/readyz", port: 8080 } }),
          }),
        ],
      },
    },
  },
});
export const service = new Service({
  metadata: { name: "smoke-app", labels: { "app.kubernetes.io/name": "smoke-app" } },
  spec: {
    selector: { "app.kubernetes.io/name": "smoke-app" },
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
  },
});
