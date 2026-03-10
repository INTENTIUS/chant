import { Chart, Values, HelmDependency } from "@intentius/chant-lexicon-helm";
import { values as v } from "@intentius/chant-lexicon-helm";
import { shared } from "../config";

export const chart = new Chart({
  apiVersion: "v2",
  name: "gitlab-cell",
  version: "0.1.0",
  appVersion: shared.gitlabChartVersion,
  type: "application",
  description: "GitLab cell wrapper chart — deploys gitlab/gitlab with cell-specific config",
});

export const gitlabDep = new HelmDependency({
  name: "gitlab",
  version: shared.gitlabChartVersion,
  repository: "https://charts.gitlab.io",
});

export const cellValues = new Values({
  // Cell-specific inputs (overridden in values-<cell>.yaml)
  cellDomain: "",
  cellName: "",
  cellId: 0,
  sequenceOffset: 0,
  pgHost: "",
  pgReadReplicaHost: "",
  pgBouncerEnabled: true,
  redisPersistentHost: "",
  redisCacheHost: "",
  projectId: "",
  artifactsBucket: "",
  registryBucket: "",
  smtpAddress: "",
  smtpPort: 587,
  smtpUser: "",
  smtpDomain: "",
  gitalyDiskSize: "50Gi",
  webserviceReplicas: 2,
  sidekiqPods: {},

  // Global config
  global: {
    hosts: {
      domain: v.cellDomain,
      https: true,
    },

    // Cells identity (REQUIRED for multi-cell GitLab)
    cells: {
      enabled: true,
      id: v.cellId,
      topology_service: {
        address: "topology-service.system.svc:8080",
      },
      sequence_offset: v.sequenceOffset,
    },

    // TLS
    ingress: {
      configureCertmanager: false,
      tls: { enabled: true, secretName: "gitlab-tls" },
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
    },

    // External PostgreSQL + PgBouncer
    psql: {
      host: v.pgHost,
      port: 5432,
      database: "gitlabhq_production",
      password: { secret: "gitlab-db-password", key: "password" },
      pgbouncer: v.pgBouncerEnabled,
      // Read replica load balancing — configured per-cell in values-<cell>.yaml
    },

    // External Redis (split persistent + cache)
    redis: {
      host: v.redisPersistentHost,
      auth: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      cache: {
        host: v.redisCacheHost,
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
      sharedState: {
        host: v.redisPersistentHost,
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      queues: {
        host: v.redisPersistentHost,
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      actioncable: {
        host: v.redisCacheHost,
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
    },

    // Root password + Rails secrets
    initialRootPassword: { secret: "gitlab-root-password", key: "password" },
    railsSecrets: { secret: "gitlab-rails-secret" },

    // Object storage (GCS via Workload Identity)
    minio: { enabled: false },
    appConfig: {
      object_store: {
        enabled: true,
        connection: {
          provider: "Google",
          google_project: v.projectId,
          google_application_default: true,
        },
      },
      artifacts: { bucket: v.artifactsBucket },
      uploads: { bucket: v.artifactsBucket },
      lfs: { bucket: v.artifactsBucket },
      packages: { bucket: v.artifactsBucket },
    },

    // SMTP
    smtp: {
      enabled: true,
      address: v.smtpAddress,
      port: v.smtpPort,
      user_name: v.smtpUser,
      domain: v.smtpDomain,
      authentication: "plain",
      starttls_auto: true,
      password: { secret: "gitlab-smtp-password", key: "password" },
    },

    // Container registry
    registry: {
      enabled: true,
      storage: { secret: "registry-storage", key: "config" },
    },
  },

  // GitLab component config
  gitlab: {
    webservice: {
      replicas: v.webserviceReplicas,
    },
    sidekiq: {
      pods: v.sidekiqPods,
    },
    pgbouncer: {
      default_pool_size: 20,
      min_pool_size: 5,
      max_client_conn: 150,
    },
    gitaly: {
      persistence: {
        enabled: true,
        size: v.gitalyDiskSize,
        storageClass: "standard-rwo",
      },
    },
  },

  // Disable bundled services
  postgresql: { install: false },
  redis: { install: false },
});
