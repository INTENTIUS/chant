import { Chart, Values, ValuesOverride, HelmDependency, HelmNotes, HelmTest } from "@intentius/chant-lexicon-helm";
import { runtimeSlot } from "@intentius/chant-lexicon-helm";
import { Pod } from "@intentius/chant-lexicon-k8s";
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
      sequence_offset: runtimeSlot("Integer ID space base for this cell (e.g. 0, 1000000, 2000000). Each cell must be spaced >= 1M apart to avoid ID collisions."),
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

    // GitLab Agent Server (KAS) — required for cluster integrations (GitOps, CI tunnels)
    kas: {
      enabled: runtimeSlot("true to enable GitLab Agent Server; requires kas.externalUrl"),
      externalUrl: runtimeSlot("WebSocket URL for KAS, e.g. wss://kas.gitlab.example.com"),
    },

    // GitLab Pages — opt-in; not required for Cells 1.0
    pages: {
      enabled: false,
      host: runtimeSlot("Pages subdomain, e.g. pages.gitlab.example.com"),
    },

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
      artifacts: { bucket: runtimeSlot("GCS bucket for CI artifacts") },
      uploads: { bucket: runtimeSlot("GCS bucket for user uploads") },
      lfs: { bucket: runtimeSlot("GCS bucket for LFS objects") },
      packages: { bucket: runtimeSlot("GCS bucket for package registry") },
      registry: { bucket: runtimeSlot("GCS bucket for container registry images") },

      // OIDC / SSO — opt-in; not required for Cells 1.0
      // providers must be an array (not a string) or the GitLab chart template will error on range.
      omniauth: {
        enabled: false,
        providers: [] as unknown[],
      },
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
        class: "nginx",
        configureCertmanager: false,
        tls: { enabled: true, secretName: "gitlab-tls" },
        // Sticky sessions: Docker push is a stateful POST→PATCH→PUT protocol. Without affinity,
        // PATCH can land on a different registry pod than POST, causing "blob upload unknown".
        // Applies to all ingresses (webservice is stateless, harmless there).
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
          "nginx.ingress.kubernetes.io/affinity": "cookie",
          "nginx.ingress.kubernetes.io/affinity-mode": "persistent",
        },
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
    // Values for the gitlab umbrella subchart (our only Helm dependency).
    // registry.storage must be nested here so it reaches the registry sub-subchart;
    // top-level registry.* keys in this wrapper chart do NOT flow into the gitlab dependency.
    gitlab: {
      registry: { storage: { secret: "registry-storage", key: "config" } },
      webservice: { minReplicas: 2, maxReplicas: 10 },
      pgbouncer: { default_pool_size: 20, min_pool_size: 5, max_client_conn: 150 },
      gitaly: {
        persistence: { enabled: true, size: "50Gi", storageClass: "pd-ssd" },
      },
      redis: { install: false },
      postgresql: { install: false },
      certmanager: { install: false },
      "nginx-ingress": { enabled: false },
      "gitlab-runner": { install: false },
    },
  },
});

// Post-install instructions — shown after every `helm install` / `helm upgrade`.
export const notes = new HelmNotes({
  content: `GitLab Cell deployed successfully!

1. Verify topology service:
   kubectl -n system exec deploy/topology-service -- wget -qO- http://localhost:8080/healthz

2. Check all pods ready:
   kubectl -n cell-{{ .Release.Name }} get pods

3. Open browser:
   https://{{ .Values.global.hosts.domain }}

4. Register runners:
   npm run register-runners  (from the chant repo root)

5. Test routing:
   curl -H "Cookie: _gitlab_session=cell{{ .Values.global.cells.id }}_test" \\
     https://{{ .Values.global.hosts.domain }}/

Initial root password:
   gcloud secrets versions access latest \\
     --secret=gitlab-{{ .Release.Name }}-root-password \\
     --project={{ .Values.global.appConfig.object_store.connection.google_project }}
`,
});

// Health test — run with: helm test <release> -n <namespace>
export const healthTest = new HelmTest({
  resource: new Pod({
    metadata: {
      name: "gitlab-health-test",
      annotations: { "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded" },
    },
    spec: {
      restartPolicy: "Never",
      containers: [{
        name: "test",
        image: "curlimages/curl:8.6.0",
        command: ["curl", "-sf", "--max-time", "10",
          "https://$(GITLAB_DOMAIN)/-/health"],
        env: [{ name: "GITLAB_DOMAIN", value: "{{ .Values.global.hosts.domain }}" }],
      }],
    },
  }),
});
