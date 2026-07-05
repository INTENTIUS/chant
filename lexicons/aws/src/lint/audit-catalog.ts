/**
 * The aws lexicon's `chant audit` catalog — metadata (title/tier/fix/authority/
 * category) for the WAW* CloudFormation post-synth rules this lexicon ships.
 * Contributed to core's aggregate via `awsPlugin.auditCatalog()` (#687, epic
 * #350); core keeps only the generic catalog machinery + cross-cutting ids.
 */

import { auditRule, type RuleMeta, type Authority } from "@intentius/chant/audit/catalog";

/** AWS Well-Architected Security Pillar — the authority chant cites for AWS security findings. */
const AWS_SEC: Authority = {
  name: "AWS — Security Pillar (Well-Architected)",
  url: "https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html",
};

/** Every WAW* audit rule's catalog entry. */
export const awsAuditCatalog: Record<string, RuleMeta> = {
  WAW010: auditRule("WAW010", "report-only", "guidance", "Redundant DependsOn", "Remove DependsOn already implied by a Ref/GetAtt.", { category: "best-practice" }),
  WAW011: auditRule("WAW011", "report-only", "guidance", "Deprecated Lambda runtime", "Upgrade to a supported Lambda runtime.", { category: "best-practice" }),
  WAW013: auditRule("WAW013", "merge-worthy", "guidance", "Child stack exports nothing", "Add stackOutput() exports the parent can reference.", { category: "correctness" }),
  WAW014: auditRule("WAW014", "report-only", "guidance", "Nested stack outputs never referenced", "Reference the outputs or split into a separate build.", { category: "best-practice" }),
  WAW015: auditRule("WAW015", "merge-worthy", "guidance", "Circular dependency between nested stacks", "Break the cycle between nested stacks.", { category: "correctness" }),
  WAW016: auditRule("WAW016", "report-only", "guidance", "Deprecated property", "Replace the deprecated CloudFormation property.", { category: "best-practice" }),
  WAW017: auditRule("WAW017", "report-only", "guidance", "Missing tags on a taggable resource", "Add tags for cost allocation and compliance.", { category: "best-practice" }),
  WAW018: auditRule("WAW018", "merge-worthy", "guidance", "S3 bucket missing public access block", "Add a PublicAccessBlockConfiguration blocking all public access.", { authority: [AWS_SEC] }),
  WAW019: auditRule("WAW019", "merge-worthy", "guidance", "Security group allows unrestricted ingress on a sensitive port", "Restrict the CIDR on SSH/RDP/database ports to known sources.", { authority: [AWS_SEC] }),
  WAW020: auditRule("WAW020", "merge-worthy", "guidance", "IAM policy uses a wildcard Action", "Scope the policy to specific actions (least privilege).", { authority: [AWS_SEC] }),
  WAW021: auditRule("WAW021", "merge-worthy", "guidance", "RDS storage not encrypted", "Enable StorageEncrypted for encryption at rest.", { authority: [AWS_SEC] }),
  WAW022: auditRule("WAW022", "report-only", "guidance", "Lambda has no VpcConfig", "Consider a VpcConfig for network isolation if the function needs VPC resources.", { category: "best-practice" }),
  WAW023: auditRule("WAW023", "report-only", "guidance", "CloudFront has no WAF web ACL", "Consider attaching a WAF web ACL.", { category: "best-practice" }),
  WAW024: auditRule("WAW024", "report-only", "guidance", "ALB access logging disabled", "Enable access logging for audit trails.", { category: "best-practice" }),
  WAW025: auditRule("WAW025", "merge-worthy", "guidance", "SNS topic not encrypted", "Set KmsMasterKeyId for encryption at rest.", { authority: [AWS_SEC] }),
  WAW026: auditRule("WAW026", "merge-worthy", "guidance", "SQS queue not encrypted", "Enable SqsManagedSseEnabled or set KmsMasterKeyId.", { authority: [AWS_SEC] }),
  WAW027: auditRule("WAW027", "report-only", "guidance", "DynamoDB point-in-time recovery disabled", "Enable PITR for recovery.", { category: "best-practice" }),
  WAW028: auditRule("WAW028", "merge-worthy", "guidance", "EBS volume not encrypted", "Enable encryption at rest.", { authority: [AWS_SEC] }),
  WAW029: auditRule("WAW029", "merge-worthy", "guidance", "Invalid DependsOn target", "Fix the dangling/self DependsOn reference.", { category: "correctness" }),
  WAW030: auditRule("WAW030", "report-only", "guidance", "Missing DependsOn for a known ordering pattern", "Add the DependsOn the pattern requires.", { category: "best-practice" }),
  WAW031: auditRule("WAW031", "report-only", "guidance", "EKS Addon missing ServiceAccountRoleArn", "Set ServiceAccountRoleArn (IRSA) for addons that need it.", { category: "best-practice" }),
  WAW032: auditRule("WAW032", "merge-worthy", "guidance", "EFS transit encryption disabled on Fargate", "Enable transit encryption for the EFS volume.", { authority: [AWS_SEC] }),
  WAW033: auditRule("WAW033", "merge-worthy", "guidance", "Solr heap exceeds Fargate task memory", "Lower SOLR_HEAP or raise task memory.", { category: "correctness" }),
  WAW034: auditRule("WAW034", "report-only", "guidance", "Fargate Solr task under-provisioned", "Allocate >= 2048MB for the Solr task.", { category: "best-practice" }),
  WAW035: auditRule("WAW035", "report-only", "guidance", "Solr container missing nofile ulimit", "Set a nofile ulimit >= 65535.", { category: "best-practice" }),
  WAW036: auditRule("WAW036", "merge-worthy", "guidance", "Non-ASCII characters in resource properties", "Remove non-ASCII characters rejected at changeset time.", { category: "correctness" }),
  WAW037: auditRule("WAW037", "merge-worthy", "guidance", "Null values in resource properties", "Fix the invalid AttrRef producing null property values.", { category: "correctness" }),
};
