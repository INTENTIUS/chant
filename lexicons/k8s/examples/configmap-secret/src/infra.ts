import {
  ConfigMap,
  Secret,
  Deployment,
  Service,
  Container,
} from "@intentius/chant-lexicon-k8s";

const labels = { "app.kubernetes.io/name": "web-app" };

export const appConfig = new ConfigMap({
  metadata: { name: "app-config", labels },
  data: {
    LOG_LEVEL: "info",
    APP_PORT: "3000",
  },
});

export const appSecret = new Secret({
  metadata: { name: "app-secret", labels },
  type: "Opaque",
  stringData: {
    DATABASE_URL: "postgres://user:pass@db:5432/app",
  },
});

export const deployment = new Deployment({
  metadata: { name: "web-app", labels },
  spec: {
    replicas: 2,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "web",
            image: "web-app:latest",
            ports: [{ containerPort: 3000, name: "http" }],
            envFrom: [
              { configMapRef: { name: "app-config" } },
              { secretRef: { name: "app-secret" } },
            ],
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
    ports: [{ port: 80, targetPort: 3000, protocol: "TCP", name: "http" }],
  },
});
