import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

export const deployment = new Deployment({
  metadata: { name: "my-app", labels: { "app.kubernetes.io/name": "my-app" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-app" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "my-app" } },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "my-app:latest",
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
  metadata: { name: "my-app", labels: { "app.kubernetes.io/name": "my-app" } },
  spec: {
    selector: { "app.kubernetes.io/name": "my-app" },
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
  },
});
