import { Chart, Values } from "@intentius/chant-lexicon-helm";
import { values, include, printf, toYaml } from "@intentius/chant-lexicon-helm";
import { StatefulSet, Service, PersistentVolumeClaim, Container } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "redis",
  version: "0.1.0",
  appVersion: "7.2.4",
  type: "application",
  description: "A Helm chart for a Redis StatefulSet with persistent storage",
});

export const valuesSchema = new Values({
  replicaCount: 3,
  image: {
    repository: "redis",
    tag: "7-alpine",
    pullPolicy: "IfNotPresent",
  },
  service: {
    port: 6379,
  },
  persistence: {
    size: "5Gi",
    storageClass: "gp3",
    accessModes: ["ReadWriteOnce"],
  },
  resources: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "250m", memory: "256Mi" },
  },
});

export const headlessService = new Service({
  metadata: {
    name: printf("%s-headless", include("redis.fullname")),
    labels: include("redis.labels"),
  },
  spec: {
    clusterIP: "None",
    ports: [{
      port: values.service.port,
      targetPort: "tcp",
      protocol: "TCP",
      name: "tcp",
    }],
    selector: include("redis.selectorLabels"),
  },
});

export const statefulSet = new StatefulSet({
  metadata: {
    name: include("redis.fullname"),
    labels: include("redis.labels"),
  },
  spec: {
    serviceName: printf("%s-headless", include("redis.fullname")),
    replicas: values.replicaCount,
    selector: {
      matchLabels: include("redis.selectorLabels"),
    },
    updateStrategy: { type: "RollingUpdate" },
    template: {
      metadata: {
        labels: include("redis.selectorLabels"),
      },
      spec: {
        securityContext: { runAsNonRoot: true, fsGroup: 999 },
        containers: [
          new Container({
            name: "redis",
            image: printf("%s:%s", values.image.repository, values.image.tag),
            imagePullPolicy: values.image.pullPolicy,
            ports: [{ containerPort: values.service.port, name: "tcp" }],
            resources: toYaml(values.resources),
            securityContext: {
              runAsUser: 999,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
            },
            volumeMounts: [
              { name: "data", mountPath: "/data" },
            ],
            livenessProbe: {
              tcpSocket: { port: values.service.port },
              initialDelaySeconds: 15,
              periodSeconds: 20,
            },
            readinessProbe: {
              tcpSocket: { port: values.service.port },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
          }),
        ],
      },
    },
    volumeClaimTemplates: [
      new PersistentVolumeClaim({
        metadata: { name: "data" },
        spec: {
          accessModes: values.persistence.accessModes,
          storageClassName: values.persistence.storageClass,
          resources: {
            requests: { storage: values.persistence.size },
          },
        },
      }),
    ],
  },
});
