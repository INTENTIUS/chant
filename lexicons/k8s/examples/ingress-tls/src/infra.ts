import {
  Deployment,
  Service,
  Ingress,
  Container,
  Probe,
} from "@intentius/chant-lexicon-k8s";

const labels = { "app.kubernetes.io/name": "web-app" };

export const deployment = new Deployment({
  metadata: { name: "web-app", labels },
  spec: {
    replicas: 3,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "web",
            image: "web-app:latest",
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
  metadata: { name: "web-app", labels },
  spec: {
    selector: labels,
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
  },
});

export const ingress = new Ingress({
  metadata: {
    name: "web-app",
    labels,
    annotations: {
      "kubernetes.io/ingress.class": "nginx",
      "cert-manager.io/cluster-issuer": "letsencrypt-prod",
    },
  },
  spec: {
    tls: [
      {
        hosts: ["app.example.com"],
        secretName: "web-app-tls",
      },
    ],
    rules: [
      {
        host: "app.example.com",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: "web-app",
                  port: { number: 80 },
                },
              },
            },
          ],
        },
      },
    ],
  },
});
