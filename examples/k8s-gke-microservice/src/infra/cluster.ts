// GCP infrastructure: GKE cluster + node pool + Workload Identity IAM bindings.
//
// Creates GCP service accounts and IAM policy members that bind
// Kubernetes SAs to GCP SAs via Workload Identity.

import {
  GkeCluster,
  GCPServiceAccount,
  IAMPolicyMember,
} from "@intentius/chant-lexicon-gcp";

// ── GKE Cluster ────────────────────────────────────────────────────

export const { cluster, nodePool } = GkeCluster({
  name: "gke-microservice",
  location: "us-central1",
  machineType: "e2-standard-4",
  minNodeCount: 2,
  maxNodeCount: 10,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
});

// ── Workload Identity — GCP Service Accounts ──────────────────────

// App SA — bound to K8s SA "microservice-app-sa" in "microservice" namespace
export const appGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-microservice-app",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE microservice app workload identity",
});

export const appWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-app-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:PROJECT_ID.svc.id.goog[microservice/microservice-app-sa]",
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-microservice-app",
  },
});

// External DNS SA — bound to K8s SA "external-dns-sa" in "kube-system" namespace
export const externalDnsGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-microservice-dns",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE microservice external-dns workload identity",
});

export const externalDnsWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-dns-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:PROJECT_ID.svc.id.goog[kube-system/external-dns-sa]",
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-microservice-dns",
  },
});

export const externalDnsDnsBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-dns-admin",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:gke-microservice-dns@PROJECT_ID.iam.gserviceaccount.com",
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: "projects/PROJECT_ID",
  },
});

// Fluent Bit SA — bound to K8s SA "fluent-bit-sa" in "gke-logging" namespace
export const fluentBitGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-microservice-logging",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE microservice fluent-bit workload identity",
});

export const fluentBitWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-logging-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:PROJECT_ID.svc.id.goog[gke-logging/fluent-bit-sa]",
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-microservice-logging",
  },
});

export const fluentBitLoggingBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-logging-writer",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:gke-microservice-logging@PROJECT_ID.iam.gserviceaccount.com",
  role: "roles/logging.logWriter",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: "projects/PROJECT_ID",
  },
});

// OTel Collector SA — bound to K8s SA "gke-otel-collector-sa" in "gke-monitoring" namespace
export const otelGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-microservice-monitoring",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE microservice otel-collector workload identity",
});

export const otelWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-monitoring-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:PROJECT_ID.svc.id.goog[gke-monitoring/gke-otel-collector-sa]",
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-microservice-monitoring",
  },
});

export const otelMonitoringBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-monitoring-writer",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:gke-microservice-monitoring@PROJECT_ID.iam.gserviceaccount.com",
  role: "roles/monitoring.metricWriter",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: "projects/PROJECT_ID",
  },
});

export const otelTraceBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-microservice-monitoring-trace",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "serviceAccount:gke-microservice-monitoring@PROJECT_ID.iam.gserviceaccount.com",
  role: "roles/cloudtrace.agent",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: "projects/PROJECT_ID",
  },
});
