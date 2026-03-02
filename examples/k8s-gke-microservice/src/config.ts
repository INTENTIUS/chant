// Cross-lexicon configuration.
// In production, populate these from GCP project outputs:
//   gcloud container clusters describe gke-microservice \
//     --region us-central1 --format json

export const config = {
  clusterName: process.env.GKE_CLUSTER_NAME ?? "gke-microservice",
  projectId: process.env.GCP_PROJECT_ID ?? "my-project",
  region: process.env.GCP_REGION ?? "us-central1",
  appGsaEmail: process.env.APP_GSA_EMAIL ?? "gke-microservice-app@my-project.iam.gserviceaccount.com",
  externalDnsGsaEmail: process.env.EXTERNAL_DNS_GSA_EMAIL ?? "gke-microservice-dns@my-project.iam.gserviceaccount.com",
  fluentBitGsaEmail: process.env.FLUENT_BIT_GSA_EMAIL ?? "gke-microservice-logging@my-project.iam.gserviceaccount.com",
  otelGsaEmail: process.env.OTEL_GSA_EMAIL ?? "gke-microservice-monitoring@my-project.iam.gserviceaccount.com",
  domain: process.env.DOMAIN ?? "api.gke-microservice-demo.dev",
  appImage: process.env.APP_IMAGE ?? "nginxinc/nginx-unprivileged:stable",
};
