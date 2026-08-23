/**
 * chant configuration — Temporal worker profiles.
 *
 * The `temporal.profiles` object is the single source of truth for how this project's
 * Temporal worker connects to Temporal Cloud. Importing this config in worker.ts means
 * connection configuration is version-controlled and TypeScript-checked — a missing
 * `taskQueue` or wrong namespace is a compile error, not a runtime failure after 5 minutes.
 *
 * Usage in worker.ts:
 *   import config from "../chant.config.ts";
 *   const profile = config.temporal.profiles[config.temporal.defaultProfile ?? "cloud"];
 */

import type { BuildParamsConfig } from "@intentius/chant";
import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

export default {
  /**
   * Per-deployment values are build-time parameters, not `process.env` reads
   * in `src/`. The `env` mapping keeps `set -a && source .env` working; the
   * read is declared, validated, and resolved once before any project file
   * loads, so the in-process and sandboxed builds see the same values
   * (chant #1728). The defaults are placeholders that build but do not deploy.
   *
   * The optional ones (`required: false`) have no static default: source
   * derives a fallback from `projectId`/`domain` when they are unset.
   */
  buildParams: {
    projectId: {
      type: "string",
      default: "my-project",
      env: "GCP_PROJECT_ID",
      description: "GCP project the whole estate is created in",
    },
    projectNumber: {
      type: "string",
      default: "000000000000",
      env: "GCP_PROJECT_NUMBER",
      description:
        "GCP project number — Google-managed service agents are addressed by number. gcloud projects describe $GCP_PROJECT_ID --format='value(projectNumber)'",
    },
    domain: {
      type: "string",
      default: "crdb.example.com",
      env: "CRDB_DOMAIN",
      description: "Base domain for the UI ingresses — east.<domain>, central.<domain>, west.<domain>",
    },
    externalDnsGsaEmailEast: { type: "string", env: "EXTERNAL_DNS_GSA_EMAIL_EAST", required: false },
    externalDnsGsaEmailCentral: { type: "string", env: "EXTERNAL_DNS_GSA_EMAIL_CENTRAL", required: false },
    externalDnsGsaEmailWest: { type: "string", env: "EXTERNAL_DNS_GSA_EMAIL_WEST", required: false },
    argoRepo: {
      type: "string",
      env: "ARGO_REPO",
      required: false,
      description: "Git source Argo watches (push your `npm run build` output here)",
    },
    argoRevision: { type: "string", default: "HEAD", env: "ARGO_REVISION" },
    ccNamespace: { type: "string", default: "config-control", env: "CC_NAMESPACE" },
    gkeEndpointEast: { type: "string", env: "GKE_ENDPOINT_EAST", required: false },
    gkeEndpointCentral: { type: "string", env: "GKE_ENDPOINT_CENTRAL", required: false },
    gkeEndpointWest: { type: "string", env: "GKE_ENDPOINT_WEST", required: false },
  } satisfies BuildParamsConfig,

  temporal: {
    profiles: {
      cloud: {
        address:    process.env.TEMPORAL_ADDRESS   ?? "crdb-deploy.a2dd6.tmprl.cloud:7233",
        namespace:  process.env.TEMPORAL_NAMESPACE ?? "crdb-deploy.a2dd6",
        taskQueue:  "crdb-deploy",
        tls:        true,
        apiKey:     { env: "TEMPORAL_API_KEY" },
      },
      local: {
        address:    "localhost:7233",
        namespace:  "default",
        taskQueue:  "crdb-deploy",
        autoStart:  true,
      },
    },
    defaultProfile: "cloud",
  } satisfies TemporalChantConfig,
};
