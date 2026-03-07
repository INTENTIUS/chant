import { Chart, Values } from "@intentius/chant-lexicon-helm";
import { values, include, printf, toYaml } from "@intentius/chant-lexicon-helm";
import { Deployment, Service, Container } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "api-with-sidecar",
  version: "0.1.0",
  appVersion: "1.0.0",
  type: "application",
  description: "A Helm chart for a multi-container pod with a sidecar",
});

export const valuesSchema = new Values({
  replicaCount: 2,
  image: {
    repository: "my-registry.io/api-server",
    tag: "latest",
    pullPolicy: "IfNotPresent",
  },
  sidecar: {
    image: {
      repository: "fluent/fluent-bit",
      tag: "3.0",
      pullPolicy: "IfNotPresent",
    },
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "100m", memory: "128Mi" },
    },
  },
  service: {
    type: "ClusterIP",
    port: 8080,
  },
  resources: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
});

export const deployment = new Deployment({
  metadata: {
    name: include("api-with-sidecar.fullname"),
    labels: include("api-with-sidecar.labels"),
  },
  spec: {
    replicas: values.replicaCount,
    selector: {
      matchLabels: include("api-with-sidecar.selectorLabels"),
    },
    template: {
      metadata: {
        labels: include("api-with-sidecar.selectorLabels"),
      },
      spec: {
        containers: [
          new Container({
            name: "api",
            image: printf("%s:%s", values.image.repository, values.image.tag),
            imagePullPolicy: values.image.pullPolicy,
            ports: [{ containerPort: values.service.port, name: "http" }],
            resources: toYaml(values.resources),
            volumeMounts: [
              { name: "shared-logs", mountPath: "/var/log/app" },
            ],
            livenessProbe: {
              httpGet: { path: "/healthz", port: "http" },
              initialDelaySeconds: 10,
              periodSeconds: 15,
            },
            readinessProbe: {
              httpGet: { path: "/ready", port: "http" },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
          }),
          new Container({
            name: "log-collector",
            image: printf(
              "%s:%s",
              values.sidecar.image.repository,
              values.sidecar.image.tag,
            ),
            imagePullPolicy: values.sidecar.image.pullPolicy,
            resources: toYaml(values.sidecar.resources),
            volumeMounts: [
              { name: "shared-logs", mountPath: "/var/log/app", readOnly: true },
            ],
          }),
        ],
        volumes: [
          { name: "shared-logs", emptyDir: {} },
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: {
    name: include("api-with-sidecar.fullname"),
    labels: include("api-with-sidecar.labels"),
  },
  spec: {
    type: values.service.type,
    ports: [{
      port: values.service.port,
      targetPort: "http",
      protocol: "TCP",
      name: "http",
    }],
    selector: include("api-with-sidecar.selectorLabels"),
  },
});
