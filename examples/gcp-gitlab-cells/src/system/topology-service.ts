import { Deployment, Service, ConfigMap } from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

const labels = {
  "app.kubernetes.io/name": "topology-service",
  "app.kubernetes.io/part-of": "system",
};

export const topologyConfig = new ConfigMap({
  metadata: { name: "topology-service", namespace: "system", labels },
  data: {
    "config.yaml": `
database:
  host: topology-db-ip
  port: 5432
  name: topology_production
  sslmode: require
server:
  port: 8080
`,
  },
});

export const topologyDeployment = new Deployment({
  metadata: { name: "topology-service", namespace: "system", labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "topology-service" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "topology-service" } },
      spec: {
        containers: [{
          name: "topology-service",
          image: shared.topologyServiceImage,
          ports: [{ name: "http", containerPort: 8080 }],
          resources: {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 5, periodSeconds: 5 },
          volumeMounts: [{ name: "config", mountPath: "/etc/topology-service" }],
        }],
        volumes: [{ name: "config", configMap: { name: "topology-service" } }],
      },
    },
  },
});

export const topologyService = new Service({
  metadata: { name: "topology-service", namespace: "system", labels },
  spec: {
    selector: { "app.kubernetes.io/name": "topology-service" },
    ports: [{ name: "http", port: 8080, targetPort: "http" }],
  },
});
