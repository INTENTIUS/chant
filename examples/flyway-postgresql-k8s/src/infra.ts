// Cross-lexicon example: K8s + Flyway in a single file.
//
// The build system's partitionByLexicon() separates resources by their
// lexicon namespace automatically. Each `chant build --lexicon <name>`
// invocation emits only the resources belonging to that lexicon.
//
// K8s resources → k8s.yaml   (via `chant build src --lexicon k8s`)
// Flyway resources → flyway.toml (via `chant build src --lexicon flyway`)

// ── K8s: PostgreSQL on Kubernetes ────────────────────────────────────

import {
  Namespace,
  StatefulSet,
  Service,
  StatefulApp,
  Secret,
} from "@intentius/chant-lexicon-k8s";

import {
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

// Namespace for all PostgreSQL resources
export const namespace = new Namespace({
  metadata: { name: "flyway-pg" },
});

// Secret for PostgreSQL credentials
export const pgSecret = new Secret({
  metadata: {
    name: "postgres-credentials",
    namespace: "flyway-pg",
  },
  stringData: {
    "POSTGRES_PASSWORD": "postgres",
  },
});

// StatefulApp composite → StatefulSet + headless Service
const pg = StatefulApp({
  name: "postgres",
  image: "postgres:16",
  port: 5432,
  replicas: 1,
  storageSize: "1Gi",
  mountPath: "/var/lib/postgresql/data",
  namespace: "flyway-pg",
  env: [
    { name: "POSTGRES_DB", value: "app" },
    { name: "POSTGRES_USER", value: "postgres" },
    {
      name: "POSTGRES_PASSWORD",
      valueFrom: {
        secretKeyRef: { name: "postgres-credentials", key: "POSTGRES_PASSWORD" },
      },
    },
  ],
});

export const postgresStatefulSet = new StatefulSet(pg.statefulSet);
export const postgresHeadless = new Service(pg.service);

// NodePort Service — exposes PostgreSQL on port 30432 for Flyway access
// from outside the cluster (mapped via k3d -p "30432:30432@server:0")
export const postgresExternal = new Service({
  metadata: {
    name: "postgres-external",
    namespace: "flyway-pg",
    labels: {
      "app.kubernetes.io/name": "postgres",
      "app.kubernetes.io/component": "database",
    },
  },
  spec: {
    type: "NodePort",
    selector: { "app.kubernetes.io/name": "postgres" },
    ports: [
      {
        port: 5432,
        targetPort: 5432,
        nodePort: 30432,
        protocol: "TCP",
        name: "postgresql",
      },
    ],
  },
});

// ── Flyway: migration configuration ─────────────────────────────────

export const project = new FlywayProject({ name: "flyway-pg" });

export const config = new FlywayConfig({
  databaseType: "postgresql",
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  validateMigrationNaming: true,
});

// Local environment — connects to PostgreSQL via the k3d NodePort
export const local = new Environment({
  url: "jdbc:postgresql://localhost:30432/app",
  user: "postgres",
  password: "postgres",
  schemas: ["public"],
});
