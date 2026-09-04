/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const gcpAuditLineage: Record<string, Lineage[]> = {
  WGC101: [
    { tool: "gcp-policy-library", rule: "GCPStorageCMEKEncryptionConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_storage_cmek_encryption_v1.yaml", relation: "overlaps" },
  ],
  WGC102: [
    { tool: "checkov", rule: "CKV_GCP_28", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "Cloud Storage Anonymous or Publicly Accessible", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/a6cd52a1-3056-4910-96a5-894de9f3f3b3/", relation: "overlaps" },
    { tool: "gcp-policy-library", rule: "GCPStorageBucketWorldReadableConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_storage_bucket_world_readable_v1.yaml", relation: "overlaps" },
  ],
  WGC104: [
    { tool: "checkov", rule: "CKV_GCP_29", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "Google Storage Bucket Level Access Disabled", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/bb0db090-5509-4853-a827-75ced0b3caa0/", relation: "overlaps" },
    { tool: "gcp-policy-library", rule: "GCPStorageBucketPolicyOnlyConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_storage_bucket_policy_only_v1.yaml", relation: "overlaps" },
  ],
  WGC105: [
    { tool: "checkov", rule: "CKV_GCP_11", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "SQL DB Instance Publicly Accessible", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/b187edca-b81e-4fdc-aff4-aab57db45edb/", relation: "overlaps" },
    { tool: "gcp-policy-library", rule: "GCPSQLWorldReadableConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_sql_world_readable_v1.yaml", relation: "overlaps" },
  ],
  WGC107: [
    { tool: "checkov", rule: "CKV_GCP_78", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "Cloud Storage Bucket Versioning Disabled", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/e7e961ac-d17e-4413-84bc-8a1fbe242944/", relation: "overlaps" },
  ],
  WGC108: [
    { tool: "checkov", rule: "CKV_GCP_14", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "SQL DB Instance Backup Disabled", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/cf3c7631-cd1e-42f3-8801-a561214a6e79/", relation: "overlaps" },
    { tool: "gcp-policy-library", rule: "GCPSQLBackupConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_sql_backup_v1.yaml", relation: "overlaps" },
  ],
  WGC109: [
    { tool: "gcp-policy-library", rule: "GCPRestrictedFirewallRulesConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_restricted_firewall_rules_v1.yaml", relation: "overlaps" },
    { tool: "checkov", rule: "CKV2_GCP_12", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
  ],
  WGC110: [
    { tool: "checkov", rule: "CKV_GCP_43", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "High Google KMS Crypto Key Rotation Period", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/d8c57c4e-bf6f-4e32-a2bf-8643532de77b/", relation: "overlaps" },
    { tool: "gcp-policy-library", rule: "GCPCMEKRotationConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_cmek_rotation_v1.yaml", relation: "overlaps" },
  ],
  WGC202: [
    { tool: "gcp-policy-library", rule: "GCPGKEEnableWorkloadIdentityConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_gke_enable_workload_identity_v1.yaml", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_GCP_69", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
  ],
  WGC203: [
    { tool: "gcp-policy-library", rule: "GCPGKEAllowedNodeSAConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_gke_allowed_node_sa_v1.yaml", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_GCP_31", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "VM With Full Cloud Access", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/bc280331-27b9-4acb-a010-018e8098aa5d/", relation: "overlaps" },
  ],
  WGC204: [
    { tool: "checkov", rule: "CKV_GCP_39", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "Shielded VM Disabled", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/1b44e234-3d73-41a8-9954-0b154135280e/", relation: "overlaps" },
  ],
  WGC301: [
    { tool: "gcp-policy-library", rule: "GCPIAMAuditLogConstraint", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_iam_audit_log.yaml", relation: "overlaps" },
    { tool: "checkov", rule: "CKV2_GCP_5", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
  ],
  WGC303: [
    { tool: "gcp-policy-library", rule: "GCPVPCSCEnsureProjectConstraintV1", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_vpc_sc_ensure_project_v1.yaml", relation: "overlaps" },
  ],
  WGC503: [
    { tool: "gcp-policy-library", rule: "GCPIAMAuditLogConstraint", url: "https://github.com/GoogleCloudPlatform/policy-library/blob/master/policies/templates/gcp_iam_audit_log.yaml", relation: "overlaps" },
    { tool: "checkov", rule: "CKV2_GCP_5", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "IAM Audit Not Properly Configured", url: "https://docs.kics.io/latest/queries/terraform-queries/gcp/89fe890f-b480-460c-8b6b-7d8b1468adb4/", relation: "overlaps" },
  ],
};
