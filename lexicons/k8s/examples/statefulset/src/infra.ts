import {
  StatefulSet,
  Service,
  PersistentVolumeClaim,
  Container,
  Probe,
} from "@intentius/chant-lexicon-k8s";

const labels = { "app.kubernetes.io/name": "postgres" };

export const pvc = new PersistentVolumeClaim({
  metadata: { name: "pg-data", labels },
  spec: {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "10Gi" } },
  },
});

export const headlessService = new Service({
  metadata: { name: "postgres-headless", labels },
  spec: {
    clusterIP: "None",
    selector: labels,
    ports: [{ port: 5432, targetPort: 5432, protocol: "TCP", name: "postgres" }],
  },
});

export const statefulSet = new StatefulSet({
  metadata: { name: "postgres", labels },
  spec: {
    serviceName: "postgres-headless",
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "postgres",
            image: "postgres:16",
            ports: [{ containerPort: 5432, name: "postgres" }],
            env: [
              { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
            ],
            volumeMounts: [
              { name: "pg-data", mountPath: "/var/lib/postgresql/data" },
            ],
            readinessProbe: new Probe({
              exec: { command: ["pg_isready", "-U", "postgres"] },
            }),
          }),
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "pg-data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "10Gi" } },
        },
      },
    ],
  },
});
