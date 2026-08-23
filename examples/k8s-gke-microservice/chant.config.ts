import type { ChantConfig } from "@intentius/chant";

/**
 * Every per-deployment value is a build-time parameter, not a `process.env`
 * read in source. The `env` mapping keeps `set -a && source .env` working;
 * the read itself is declared, validated, and resolved once before any
 * project file loads, so the in-process and sandboxed builds see the same
 * values (chant #1728).
 *
 * In production, populate these from GCP project outputs:
 *   gcloud container clusters describe gke-microservice \
 *     --region us-central1 --format json
 */
export default {
  lexicons: ["gcp", "k8s"],
  buildParams: {
    clusterName: { type: "string", default: "gke-microservice", env: "GKE_CLUSTER_NAME" },
    projectId: { type: "string", default: "my-project", env: "GCP_PROJECT_ID" },
    region: { type: "string", default: "us-central1", env: "GCP_REGION" },
    appGsaEmail: {
      type: "string",
      default: "gke-microservice-app@my-project.iam.gserviceaccount.com",
      env: "APP_GSA_EMAIL",
    },
    externalDnsGsaEmail: {
      type: "string",
      default: "gke-microservice-dns@my-project.iam.gserviceaccount.com",
      env: "EXTERNAL_DNS_GSA_EMAIL",
    },
    fluentBitGsaEmail: {
      type: "string",
      default: "gke-microservice-logging@my-project.iam.gserviceaccount.com",
      env: "FLUENT_BIT_GSA_EMAIL",
    },
    otelGsaEmail: {
      type: "string",
      default: "gke-microservice-monitoring@my-project.iam.gserviceaccount.com",
      env: "OTEL_GSA_EMAIL",
    },
    domain: { type: "string", default: "api.gke-microservice-demo.dev", env: "DOMAIN" },
    appImage: { type: "string", default: "nginxinc/nginx-unprivileged:stable", env: "APP_IMAGE" },
  },
} satisfies ChantConfig;
