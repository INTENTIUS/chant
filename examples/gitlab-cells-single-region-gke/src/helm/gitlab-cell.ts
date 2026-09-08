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

// Deploy-time slots, one named const each.
//
// `runtimeSlot()` is a plain function call, and a resource constructor property
// must be statically evaluable (EVL001) — so the calls live here and the
// constructor below references the names. Nothing about the emitted chart
// changes: every slot still renders as '' in values.yaml and as a described
// entry in values-runtime-slots.yaml. Naming them also lets the three
// persistent-Redis fields and the two cache fields share one slot instead of
// repeating the description.
const cellDomainSlot = runtimeSlot("cell domain, e.g. alpha.gitlab.example.com");
const cellIdSlot = runtimeSlot("cell ID integer");
const sequenceOffsetSlot = runtimeSlot("Integer ID space base for this cell (e.g. 0, 1000000, 2000000). Each cell must be spaced >= 1M apart to avoid ID collisions.");
const psqlHostSlot = runtimeSlot("Cloud SQL private IP (kubectl get sqlinstances ... -o jsonpath='.status.privateIpAddress')");
const pgbouncerEnabledSlot = runtimeSlot("whether PgBouncer is enabled");
const redisPersistentHostSlot = runtimeSlot("Memorystore persistent host");
const redisCacheHostSlot = runtimeSlot("Memorystore cache host");
const kasEnabledSlot = runtimeSlot("true to enable GitLab Agent Server; requires kas.externalUrl");
const kasExternalUrlSlot = runtimeSlot("WebSocket URL for KAS, e.g. wss://kas.gitlab.example.com");
const pagesHostSlot = runtimeSlot("Pages subdomain, e.g. pages.gitlab.example.com");
const googleProjectSlot = runtimeSlot("GCP project ID");
const artifactsBucketSlot = runtimeSlot("GCS bucket for CI artifacts");
const uploadsBucketSlot = runtimeSlot("GCS bucket for user uploads");
const lfsBucketSlot = runtimeSlot("GCS bucket for LFS objects");
const packagesBucketSlot = runtimeSlot("GCS bucket for package registry");
const registryBucketSlot = runtimeSlot("GCS bucket for container registry images");
const smtpAddressSlot = runtimeSlot("SMTP server address");
const smtpPortSlot = runtimeSlot("SMTP port");
const smtpUserSlot = runtimeSlot("SMTP username");
const smtpDomainSlot = runtimeSlot("SMTP domain");
const webserviceReplicasSlot = runtimeSlot("webservice replica count");
const sidekiqPodsSlot = runtimeSlot("sidekiq pods array");
const gitalyDiskSizeSlot = runtimeSlot("Gitaly PVC size, e.g. 100Gi");

export const cellValues = new Values({
  // Global config (runtime slots are filled via values-<cell>.yaml at deploy time)
  global: {
    hosts: {
      domain: cellDomainSlot,
      https: true,
    },

    // Cells identity (REQUIRED for multi-cell GitLab)
    cells: {
      enabled: true,
      id: cellIdSlot,
      topology_service: {
        address: "topology-service.system.svc:8080",
      },
      sequence_offset: sequenceOffsetSlot,
    },

    // TLS (static — shared across all cells)
    ingress: {
      configureCertmanager: false,
      tls: { enabled: true, secretName: "gitlab-tls" },
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
    },

    // External PostgreSQL + PgBouncer
    psql: {
      host: psqlHostSlot,
      port: 5432,
      database: "gitlabhq_production",
      password: { secret: "gitlab-db-password", key: "password" },
      pgbouncer: pgbouncerEnabledSlot,
    },

    // External Redis (split persistent + cache)
    redis: {
      host: redisPersistentHostSlot,
      auth: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      cache: {
        host: redisCacheHostSlot,
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
      sharedState: {
        host: redisPersistentHostSlot,
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      queues: {
        host: redisPersistentHostSlot,
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      actioncable: {
        host: redisCacheHostSlot,
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
    },

    // Root password + Rails secrets
    initialRootPassword: { secret: "gitlab-root-password", key: "password" },
    railsSecrets: { secret: "gitlab-rails-secret" },

    // GitLab Agent Server (KAS) — required for cluster integrations (GitOps, CI tunnels)
    kas: {
      enabled: kasEnabledSlot,
      externalUrl: kasExternalUrlSlot,
    },

    // GitLab Pages — opt-in; not required for Cells 1.0
    pages: {
      enabled: false,
      host: pagesHostSlot,
    },

    // Object storage (GCS via Workload Identity)
    minio: { enabled: false },
    appConfig: {
      object_store: {
        enabled: true,
        connection: {
          provider: "Google",
          google_project: googleProjectSlot,
          google_application_default: true,
        },
      },
      artifacts: { bucket: artifactsBucketSlot },
      uploads: { bucket: uploadsBucketSlot },
      lfs: { bucket: lfsBucketSlot },
      packages: { bucket: packagesBucketSlot },
      registry: { bucket: registryBucketSlot },

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
      address: smtpAddressSlot,
      port: smtpPortSlot,
      user_name: smtpUserSlot,
      domain: smtpDomainSlot,
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
      replicas: webserviceReplicasSlot,
    },
    sidekiq: {
      pods: sidekiqPodsSlot,
    },
    pgbouncer: {
      default_pool_size: 20,
      min_pool_size: 5,
      max_client_conn: 150,
    },
    gitaly: {
      persistence: {
        enabled: true,
        size: gitalyDiskSizeSlot,
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
