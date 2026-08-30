import type { ChantConfig } from "@intentius/chant";

/**
 * Every per-deployment value is a build-time parameter, not a `process.env`
 * read in `src/`. The `env` mapping keeps `set -a && source .env` working
 * (see `.env.example` and `scripts/load-outputs.sh`); the read itself is
 * declared, validated, and resolved once before any project file loads, so
 * the in-process and sandboxed builds see the same values (chant #1728).
 * `src/chant.config.json` is only a lint-scoping fragment; the project-config
 * walk skips it and lands here.
 *
 * The defaults are placeholders that build but do not deploy. The ones with
 * `required: false` have no static default: source derives a fallback from
 * `projectId` when they are unset.
 */
export default {
  lexicons: ["gcp", "k8s", "helm", "gitlab", "k3d"],
  buildParams: {
    // ── Required ──
    projectId: { type: "string", default: "my-project", env: "GCP_PROJECT_ID" },
    region: { type: "string", default: "us-central1", env: "GCP_REGION" },
    domain: { type: "string", default: "gitlab.example.com", env: "DOMAIN" },

    // ── GKE cluster sizing (minNodeCount is per-zone; regional cluster = 3 zones) ──
    machineType: { type: "string", default: "e2-standard-8", env: "MACHINE_TYPE" },
    minNodeCount: { type: "number", default: 3, env: "MIN_NODE_COUNT" },
    maxNodeCount: { type: "number", default: 20, env: "MAX_NODE_COUNT" },
    nodeDiskSizeGb: { type: "number", default: 200, env: "NODE_DISK_SIZE_GB" },
    ingressReplicas: { type: "number", default: 2, env: "INGRESS_REPLICAS" },

    // ── SMTP (for GitLab email: confirmations, notifications, alerts) ──
    smtpAddress: { type: "string", default: "smtp.sendgrid.net", env: "SMTP_ADDRESS" },
    smtpPort: { type: "number", default: 587, env: "SMTP_PORT" },
    smtpUser: { type: "string", default: "apikey", env: "SMTP_USER" },
    smtpDomain: { type: "string", default: "gitlab.example.com", env: "SMTP_DOMAIN" },
    letsEncryptEmail: { type: "string", default: "admin@example.com", env: "LETSENCRYPT_EMAIL" },

    // ── GitLab Runner ──
    runnerReplicas: { type: "number", default: 2, env: "RUNNER_REPLICAS" },
    runnerConcurrency: { type: "number", default: 10, env: "RUNNER_CONCURRENCY" },
    runnerNodePoolEnabled: {
      type: "boolean",
      default: false,
      env: "RUNNER_NODE_POOL_ENABLED",
      description: "Set to true to isolate runners on dedicated nodes",
    },
    runnerNodePoolMachineType: { type: "string", default: "e2-standard-4", env: "RUNNER_NODE_POOL_MACHINE_TYPE" },
    runnerNodePoolMaxCount: { type: "number", default: 10, env: "RUNNER_NODE_POOL_MAX_COUNT" },

    // ── Images (default: gcr.io/<projectId>/<name>:latest, derived in src/config.ts) ──
    topologyServiceImage: { type: "string", env: "TOPOLOGY_SERVICE_IMAGE", required: false },
    cellRouterImage: { type: "string", env: "CELL_ROUTER_IMAGE", required: false },

    // ── Optional: Prometheus remote write (leave blank to disable) ──
    prometheusRemoteWriteUrl: { type: "string", default: "", env: "PROMETHEUS_REMOTE_WRITE_URL" },
    routerHealthThreshold: {
      type: "number",
      default: 0.5,
      env: "ROUTER_HEALTH_THRESHOLD",
      description: "Health score threshold below which the cell router fails over to the next available cell",
    },

    // ── Runtime outputs written to .env by scripts/load-outputs.sh after deploy ──
    ingressIp: { type: "string", default: "0.0.0.0", env: "INGRESS_IP" },
    topologyDbHost: { type: "string", default: "topology-db-ip", env: "TOPOLOGY_DB_HOST" },
    alphaDbIp: { type: "string", default: "", env: "ALPHA_DB_IP" },
    alphaRedisPersistent: { type: "string", default: "", env: "ALPHA_REDIS_PERSISTENT" },
    alphaRedisCache: { type: "string", default: "", env: "ALPHA_REDIS_CACHE" },
    betaDbIp: { type: "string", default: "", env: "BETA_DB_IP" },
    betaRedisPersistent: { type: "string", default: "", env: "BETA_REDIS_PERSISTENT" },
    betaRedisCache: { type: "string", default: "", env: "BETA_REDIS_CACHE" },
  },
} satisfies ChantConfig;
