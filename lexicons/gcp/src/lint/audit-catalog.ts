/**
 * The gcp lexicon's `chant audit` catalog — metadata for the WGC* Config
 * Connector post-synth rules. Contributed via `gcpPlugin.auditCatalog()` (#687).
 */
import { auditRule, type RuleMeta, type Authority } from "@intentius/chant/audit/catalog";

const GCP_SEC: Authority = { name: "Google Cloud — Security best practices", url: "https://cloud.google.com/security/best-practices" };

export const gcpAuditCatalog: Record<string, RuleMeta> = {
  WGC101: auditRule("WGC101", "merge-worthy", "guidance", "Storage/SQL without encryption configuration", "Configure encryption (e.g. a CMEK key) for data at rest.", { authority: [GCP_SEC] }),
  WGC102: auditRule("WGC102", "merge-worthy", "guidance", "Public IAM member (allUsers/allAuthenticatedUsers)", "Remove allUsers/allAuthenticatedUsers bindings.", { authority: [GCP_SEC] }),
  WGC103: auditRule("WGC103", "report-only", "guidance", "Missing project-id annotation", "Add the cnrm.cloud.google.com/project-id annotation.", { category: "best-practice" }),
  WGC104: auditRule("WGC104", "merge-worthy", "guidance", "Bucket without uniform bucket-level access", "Enable uniformBucketLevelAccess.", { authority: [GCP_SEC] }),
  WGC105: auditRule("WGC105", "merge-worthy", "guidance", "Cloud SQL open to 0.0.0.0/0", "Restrict authorizedNetworks to known sources.", { authority: [GCP_SEC] }),
  WGC106: auditRule("WGC106", "report-only", "guidance", "Missing deletion-policy annotation", "Add the cnrm.cloud.google.com/deletion-policy annotation.", { category: "best-practice" }),
  WGC107: auditRule("WGC107", "report-only", "guidance", "Bucket versioning disabled", "Enable object versioning.", { category: "best-practice" }),
  WGC108: auditRule("WGC108", "report-only", "guidance", "Cloud SQL backups disabled", "Enable backup configuration.", { category: "best-practice" }),
  WGC109: auditRule("WGC109", "merge-worthy", "guidance", "Firewall open to 0.0.0.0/0", "Restrict sourceRanges to known sources.", { authority: [GCP_SEC] }),
  WGC110: auditRule("WGC110", "merge-worthy", "guidance", "KMS key without rotation", "Set a rotationPeriod on the CryptoKey.", { authority: [GCP_SEC] }),
  WGC111: auditRule("WGC111", "merge-worthy", "guidance", "Reference to an undefined resource", "Point the reference at a resource in the output.", { category: "correctness" }),
  WGC112: auditRule("WGC112", "merge-worthy", "guidance", "Missing or invalid apiVersion", "Set a valid cnrm.cloud.google.com apiVersion.", { category: "correctness" }),
  WGC113: auditRule("WGC113", "report-only", "guidance", "Alpha API version", "Move to a beta/GA API version.", { category: "best-practice" }),
  WGC201: auditRule("WGC201", "report-only", "guidance", "Missing managed-by label", "Add the app.kubernetes.io/managed-by label.", { category: "best-practice" }),
  WGC202: auditRule("WGC202", "merge-worthy", "guidance", "Cluster without Workload Identity", "Enable Workload Identity on the ContainerCluster.", { authority: [GCP_SEC] }),
  WGC203: auditRule("WGC203", "merge-worthy", "guidance", "Node pool uses broad cloud-platform scope", "Use narrowly-scoped OAuth scopes instead of cloud-platform.", { authority: [GCP_SEC] }),
  WGC204: auditRule("WGC204", "report-only", "guidance", "Compute instance without Shielded VM", "Enable Shielded VM configuration.", { category: "best-practice" }),
  WGC301: auditRule("WGC301", "report-only", "guidance", "No IAMAuditConfig found", "Configure audit logging via IAMAuditConfig.", { category: "best-practice" }),
  WGC302: auditRule("WGC302", "report-only", "guidance", "No Service (enabled APIs) found", "Declare the GCP APIs you depend on.", { category: "best-practice" }),
  WGC303: auditRule("WGC303", "report-only", "guidance", "No VPC Service Controls perimeter", "Consider an AccessContextManager ServicePerimeter.", { category: "best-practice" }),
  WGC401: auditRule("WGC401", "merge-worthy", "guidance", "Unknown field in resource spec", "Remove the unknown spec field.", { category: "correctness" }),
  WGC402: auditRule("WGC402", "merge-worthy", "guidance", "Missing required spec field", "Add the required spec field.", { category: "correctness" }),
  WGC403: auditRule("WGC403", "merge-worthy", "guidance", "Spec field has wrong type/structure", "Fix the field's type/structure.", { category: "correctness" }),
};
