import { Chart, Values, ValuesOverride, HelmDependency } from "@intentius/chant-lexicon-helm";
import { runtimeSlot } from "@intentius/chant-lexicon-helm";
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
  // Global config (runtime slots are filled via values-<cell>.yaml at deploy time)
  global: {
    hosts: {
      domain: runtimeSlot("cell domain, e.g. alpha.gitlab.example.com"),
      https: true,
    },

    // Cells identity (REQUIRED for multi-cell GitLab)
    cells: {
      enabled: true,
      id: runtimeSlot("cell ID integer"),
      topology_service: {
        address: "topology-service.system.svc:8080",
      },
      sequence_offset: runtimeSlot("sequence offset integer"),
    },

    // TLS (static — shared across all cells)
    ingress: {
      configureCertmanager: false,
      tls: { enabled: true, secretName: "gitlab-tls" },
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
    },

    // External PostgreSQL + PgBouncer
    psql: {
      host: runtimeSlot("Cloud SQL private IP (kubectl get sqlinstances ... -o jsonpath='.status.privateIpAddress')"),
      port: 5432,
      database: "gitlabhq_production",
      password: { secret: "gitlab-db-password", key: "password" },
      pgbouncer: runtimeSlot("whether PgBouncer is enabled"),
    },

    // External Redis (split persistent + cache)
    redis: {
      host: runtimeSlot("Memorystore persistent host"),
      auth: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      cache: {
        host: runtimeSlot("Memorystore cache host"),
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
      sharedState: {
        host: runtimeSlot("Memorystore persistent host"),
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      queues: {
        host: runtimeSlot("Memorystore persistent host"),
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      actioncable: {
        host: runtimeSlot("Memorystore cache host"),
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
          google_project: runtimeSlot("GCP project ID"),
          google_application_default: true,
        },
      },
      artifacts: { bucket: runtimeSlot("GCS artifacts bucket name") },
      uploads: { bucket: runtimeSlot("GCS artifacts bucket name") },
      lfs: { bucket: runtimeSlot("GCS artifacts bucket name") },
      packages: { bucket: runtimeSlot("GCS artifacts bucket name") },
      registry: { bucket: runtimeSlot("GCS registry bucket name") },
    },

    // SMTP
    smtp: {
      enabled: true,
      address: runtimeSlot("SMTP server address"),
      port: runtimeSlot("SMTP port"),
      user_name: runtimeSlot("SMTP username"),
      domain: runtimeSlot("SMTP domain"),
      authentication: "plain",
      starttls_auto: true,
      password: { secret: "gitlab-smtp-password", key: "password" },
    },

    // Container registry (enabled globally; storage config is at registry.storage subchart level)
    registry: { enabled: true },
  },

  // GitLab component config
  gitlab: {
    webservice: {
      replicas: runtimeSlot("webservice replica count"),
    },
    sidekiq: {
      pods: runtimeSlot("sidekiq pods array"),
    },
    pgbouncer: {
      default_pool_size: 20,
      min_pool_size: 5,
      max_client_conn: 150,
    },
    gitaly: {
      persistence: {
        enabled: true,
        size: runtimeSlot("Gitaly PVC size, e.g. 100Gi"),
        storageClass: "pd-ssd",
      },
    },
  },

  // registry.storage is subchart-level config (not global.registry.storage)
  registry: { storage: { secret: "registry-storage", key: "config" } },

  // Disable bundled services
  postgresql: { install: false },
  redis: { install: false },
});

// Static shared overrides — generated to gitlab-cell/values-base.yaml
// Pass as: helm upgrade gitlab-cell -f gitlab-cell/values-base.yaml -f values-<cell>.yaml
export const baseOverride = new ValuesOverride({
  filename: "values-base",
  values: {
    global: {
      hosts: {
        https: true,
      },
      ingress: {
        configureCertmanager: false,
        tls: { enabled: true, secretName: "gitlab-tls" },
        annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
      },
      psql: {
        port: 5432,
        database: "gitlabhq_production",
        password: { secret: "gitlab-db-password", key: "password" },
        pgbouncer: true,
      },
      redis: {
        auth: { enabled: true, secret: "gitlab-redis-password", key: "password" },
        cache: {
          password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
        },
        sharedState: {
          password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
        },
        queues: {
          password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
        },
        actioncable: {
          password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
        },
      },
      initialRootPassword: { secret: "gitlab-root-password", key: "password" },
      railsSecrets: { secret: "gitlab-rails-secret" },
      minio: { enabled: false },
      appConfig: {
        object_store: {
          enabled: true,
          connection: {
            secret: "gitlab-object-store-connection",
            key: "connection",
          },
        },
      },
      smtp: { enabled: false },
      registry: { enabled: true },
      cells: {
        enabled: true,
        topology_service: { address: "topology-service.system.svc:8080" },
      },
    },
    // registry.storage is subchart-level config, not global.registry.storage
    registry: { storage: { secret: "registry-storage", key: "config" } },
    gitlab: {
      webservice: { replicas: 2 },
      pgbouncer: { default_pool_size: 20, min_pool_size: 5, max_client_conn: 150 },
      gitaly: {
        persistence: { enabled: true, size: "50Gi", storageClass: "pd-ssd" },
      },
    },
    postgresql: { install: false },
    redis: { install: false },
    certmanager: { install: false },
    "nginx-ingress": { enabled: false },
    "gitlab-runner": { install: false },
  },
});
