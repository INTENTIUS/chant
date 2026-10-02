/**
 * The terraform lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through `terraformPlugin.auditCatalog()` (#687, #1346).
 * Every post-synth check needs an entry or it contributes nothing to
 * `chant audit`, silently, and `packages/core/src/audit/catalog.test.ts` fails.
 *
 * TF001 and TF024 through TF029 all read the chant model (`ctx.entities`),
 * never emitted output, so `yamlBased` is false for all of them. Prior-art
 * lineage lives in ./audit-lineage.ts.
 */
import type { Authority, RuleMeta } from "@intentius/chant/audit/catalog";
import { applyLineage } from "@intentius/chant/audit/catalog";
import { terraformAuditLineage } from "./audit-lineage";

const HASHICORP_STYLE_VARIABLES: Authority = {
  name: "HashiCorp Terraform style guide — Variables",
  url: "https://developer.hashicorp.com/terraform/language/style#variables",
};

const AWS_IAM_LEAST_PRIVILEGE: Authority = {
  name: "AWS IAM security best practices (Apply least-privilege permissions)",
  url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege",
};

// TF032's authority: the ECS developer guide's own instruction for credentials,
// which is the remediation the rule's message gives.
const ECS_SENSITIVE_DATA: Authority = {
  name: "Amazon ECS Developer Guide: Pass sensitive data to an Amazon ECS container",
  url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html",
};

// TF033-TF037 (#2288) cite the AWS service guide page that states the
// encryption or immutability control each rule checks.
const AWS_RDS_ENCRYPTION: Authority = {
  name: "Amazon RDS User Guide: Encrypting Amazon RDS resources",
  url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html",
};

const AWS_SNS_SSE: Authority = {
  name: "Amazon SNS Developer Guide: Securing Amazon SNS data with server-side encryption",
  url: "https://docs.aws.amazon.com/sns/latest/dg/sns-server-side-encryption.html",
};

const AWS_SQS_SSE: Authority = {
  name: "Amazon SQS Developer Guide: Encryption at rest in Amazon SQS",
  url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html",
};

const AWS_EBS_ENCRYPTION: Authority = {
  name: "Amazon EBS User Guide: Amazon EBS encryption",
  url: "https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption.html",
};

const AWS_ECR_TAG_IMMUTABILITY: Authority = {
  name: "Amazon ECR User Guide: Preventing image tags from being overwritten",
  url: "https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html",
};

// The vendor guides behind TF014, TF015 and TF021 are credited as lineage in
// ./audit-lineage.ts, not as `authority` here. `authority` is reserved for
// security rules that fail a merge (packages/core/src/audit/catalog.test.ts
// holds both halves of that invariant), and these three are correctness and
// best-practice rules (#2112).

/**
 * The document WAW019 cites for the same finding in the aws lexicon, named
 * without the em-dash its entry there carries (the docs prose lint counts them).
 */
const AWS_SECURITY_PILLAR: Authority = {
  name: "AWS Well-Architected Framework, Security Pillar",
  url: "https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html",
};

export const terraformAuditCatalog: Record<string, RuleMeta> = {
  TF001: {
    id: "TF001",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Root module declares no remote backend",
    remediation:
      'Add a `backend "<type>"` block (s3, gcs, azurerm, http) or a `cloud {}` block to the root ' +
      "module's terraform block, then `terraform init -migrate-state`.",
    yamlBased: false,
  },
  TF024: {
    id: "TF024",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Live root declares a backend or cloud block, which choudoufu refuses",
    remediation:
      "Remove the `backend`/`cloud` block from the live root's terraform block; a live root's prior " +
      "state is a projection rebuilt from the live system every run, so there is no state to store.",
    yamlBased: false,
  },
  TF025: {
    id: "TF025",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Live root references a non-default terraform.workspace, which choudoufu refuses",
    remediation:
      "Remove `workspace` from the root's terraform.roots config, and remove any `terraform.workspace` " +
      'reference from its HCL; choudoufu refuses any workspace but "default" on a live root.',
    yamlBased: false,
  },
  TF026: {
    id: "TF026",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: 'Live root declares delete: "never" but its policy leaves undeclared_tagged at "delete"',
    remediation:
      'Add undeclared_tagged = "keep" (or "untag" or "report") to the live root\'s policy block, or ' +
      'change terraform.roots.<name>.delete to "owned-only" or "gated" if an owned orphan should be ' +
      "deleted after all.",
    yamlBased: false,
  },
  TF027: {
    id: "TF027",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: 'Live root\'s policy block sets undeclared_untagged = "delete"',
    remediation:
      'Remove undeclared_untagged = "delete" from the live root\'s policy block. chant never proposes ' +
      "deleting a resource it does not own; narrow the estate's own ownership answer " +
      "(undeclared_tagged) instead of the account's.",
    yamlBased: false,
  },
  TF028: {
    id: "TF028",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Live root is watched by a TerraformWatchOp built without live: true",
    remediation:
      "Set live: true on the TerraformWatchOp that names this root, so the Plan phase runs " +
      "choudoufuLivePlan and reports the unowned and adoptable counts as well as drift. Drop the root's " +
      "estate instead if it is not a live root.",
    yamlBased: false,
  },
  TF029: {
    id: "TF029",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Live root names its estate both in chant.config and in its own HCL",
    remediation:
      "Pick one. A root whose directory is shared across environments declares no estate in HCL and " +
      "names it per root with terraform.roots.<name>.estate; a root with its own live block already " +
      "has an estate and needs nothing in chant.config. The declaration wins today, so the config " +
      "value is written down and never used.",
    yamlBased: false,
  },
  TF002: {
    id: "TF002",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Provider implied by the root has no required_providers entry",
    remediation:
      "Add the provider to the terraform block's `required_providers`, with both `source` and " +
      "`version` set, so a future provider release can't silently change behavior.",
    yamlBased: false,
  },
  TF003: {
    id: "TF003",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Root module's terraform block has no required_version",
    remediation: 'Set `required_version = ">= <lowest supported version>"` in the terraform block.',
    yamlBased: false,
  },
  TF004: {
    id: "TF004",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Registry-sourced module block has no version",
    remediation: "Add a `version` constraint to the module block (e.g. `~> 5.0`).",
    yamlBased: false,
  },
  TF005: {
    id: "TF005",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Git/hg module source is unpinned, or pinned to a mutable ref",
    remediation: "Pin the module's `?ref=` to a tag or a full commit SHA.",
    yamlBased: false,
  },
  TF006: {
    id: "TF006",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Default value on a sensitive variable",
    remediation:
      "Delete the `default` and require the caller to supply the value at apply time, through a tfvars " +
      "file kept out of version control, a `TF_VAR_` entry in the environment, or a workspace input.",
    yamlBased: false,
  },
  TF007: {
    id: "TF007",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Plaintext secret in a variable default or a locals value",
    remediation:
      "Remove the literal, mark the variable `sensitive = true`, and read the value from a secret " +
      "manager data source or an input at apply time, then rotate the credential, which is already " +
      "in version control history.",
    yamlBased: false,
  },
  TF008: {
    id: "TF008",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Provider block configures a hardcoded credential",
    remediation:
      "Delete the credential from the provider block and let the provider read it from the " +
      "environment, a shared credentials file, or an OIDC role assumption. Rotate the credential.",
    yamlBased: false,
  },
  TF009: {
    id: "TF009",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Credential-named variable is not marked sensitive",
    remediation:
      "Add `sensitive = true` to the variable so its value is not printed in plan and apply output. " +
      "The value is still stored in plaintext in state, so keep the state remote and encrypted.",
    authority: [HASHICORP_STYLE_VARIABLES],
    yamlBased: false,
  },
  TF010: {
    id: "TF010",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Variable declares no type constraint",
    remediation: "Add a `type` to the variable (`string`, `number`, `bool`, `list(string)`, `object({...})`).",
    yamlBased: false,
  },
  TF011: {
    id: "TF011",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Undocumented variable",
    remediation: "Add a `description` saying what the value is for and what a valid one looks like.",
    yamlBased: false,
  },
  TF012: {
    id: "TF012",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Undocumented output",
    remediation: "Write a `description` for the output, covering what the value is and what a caller can rely on it for.",
    yamlBased: false,
  },
  TF013: {
    id: "TF013",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "lifecycle ignore_changes is set to all",
    remediation:
      "Replace `ignore_changes = all` with the list of attributes that genuinely change outside " +
      "Terraform, so every other attribute is still reconciled.",
    yamlBased: false,
  },
  TF014: {
    id: "TF014",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Child module configures a provider block",
    remediation:
      "Move the provider configuration to the root module and pass it into the module with " +
      "`providers = { ... }`, leaving at most an `alias`-only block in the module.",
    yamlBased: false,
  },
  TF015: {
    id: "TF015",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "correctness",
    title: "Child module declares a backend or cloud block",
    remediation:
      "Delete the `backend`/`cloud` block from the child module. State belongs to the root module " +
      "that calls it, one state for the whole tree.",
    yamlBased: false,
  },
  TF020: {
    id: "TF020",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Declaration is never referenced in its module scope",
    remediation:
      "Delete the variable, local, data source or aliased provider, or reference it where it was " +
      "meant to be used.",
    yamlBased: false,
  },
  TF021: {
    id: "TF021",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "count builds instance identities from count.index where for_each is safer",
    remediation:
      "Switch to `for_each` over a map or set so each instance is addressed by a stable key, then " +
      "`terraform state mv` the existing indexed instances onto their new keys.",
    yamlBased: false,
  },
  TF016: {
    id: "TF016",
    tier: "report-only",
    fixKind: "deterministic",
    category: "best-practice",
    title: "Attribute value is a quoted interpolation of a single expression",
    remediation: 'Drop the quotes and the `${}`: write `x = var.y`, not `x = "${var.y}"`.',
    yamlBased: false,
  },
  TF017: {
    id: "TF017",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Module block uses depends_on",
    remediation:
      "Remove `depends_on` from the module call and pass an attribute of the dependency into a module " +
      "input, so Terraform derives the narrower edge itself.",
    yamlBased: false,
  },
  TF018: {
    id: "TF018",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Output value is a whole resource or data source",
    remediation: "Return the attribute the caller needs (`.id`, `.arn`, `.endpoint`) instead of the whole block.",
    yamlBased: false,
  },
  TF019: {
    id: "TF019",
    tier: "report-only",
    fixKind: "deterministic",
    category: "best-practice",
    title: "Meta-argument explicitly set to its default of false",
    remediation: "Deleting the line is the whole fix. `sensitive`, `ephemeral`, `prevent_destroy` and `create_before_destroy` are false unless set.",
    yamlBased: false,
  },
  TF022: {
    id: "TF022",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Credential-named resource attribute holds a plaintext literal",
    remediation:
      "Replace the constant with a lookup, either an input the caller supplies or a data source " +
      "pointed at whatever vault owns the credential, and rotate what was committed.",
    yamlBased: false,
  },
  TF030: {
    id: "TF030",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Security group rule allows unrestricted ingress on a sensitive port",
    remediation:
      "Restrict the CIDR on SSH, RDP, MySQL and PostgreSQL ports to the sources that need them, or reach " +
      "the host through a bastion, a VPN or SSM Session Manager.",
    authority: [AWS_SECURITY_PILLAR],
    yamlBased: false,
  },
  TF031: {
    id: "TF031",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "IAM policy allows a wildcard Action or Resource",
    remediation:
      "Name the actions the workload calls and the ARNs it touches. For the few actions that accept only " +
      'Resource "*" (`ecr:GetAuthorizationToken`, `sts:GetCallerIdentity`), keep that statement on its own and ' +
      "suppress it with `# chant-ignore-block: TF031`. A policy TF031 reports as not determined is built from " +
      "an expression; it is not a finding.",
    authority: [AWS_IAM_LEAST_PRIVILEGE],
    yamlBased: false,
  },
  TF032: {
    id: "TF032",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "ECS container definition passes a credential as a plaintext environment value",
    remediation:
      "Move the value from the container's `environment` to its `secrets`, with a `valueFrom` naming a " +
      "Secrets Manager secret or SSM parameter, and rotate the committed value.",
    authority: [ECS_SENSITIVE_DATA],
    yamlBased: false,
  },
  TF033: {
    id: "TF033",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "RDS DB instance or cluster storage is not encrypted",
    remediation:
      "Set `storage_encrypted = true` (and `kms_key_id` for a customer managed key). An existing database cannot be " +
      "encrypted in place: restore an encrypted copy of a snapshot. An Aurora cluster, or a database created from a " +
      "snapshot or replica, is reported as not determined, not as a finding.",
    authority: [AWS_RDS_ENCRYPTION],
    yamlBased: false,
  },
  TF034: {
    id: "TF034",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "SNS topic has no server-side encryption",
    remediation:
      'Set `kms_master_key_id` to a customer managed KMS key, or to `"alias/aws/sns"` for the AWS managed one. No AWS ' +
      "default encrypts a topic that names no key.",
    authority: [AWS_SNS_SSE],
    yamlBased: false,
  },
  TF035: {
    id: "TF035",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "SQS queue turns server-side encryption off",
    remediation:
      "Remove `sqs_managed_sse_enabled = false` (new queues are encrypted with SSE-SQS by default), set it to `true`, " +
      "or set `kms_master_key_id`. A queue that sets neither attribute is encrypted and is not reported.",
    authority: [AWS_SQS_SSE],
    yamlBased: false,
  },
  TF036: {
    id: "TF036",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "EBS volume does not ask for encryption",
    remediation:
      "Set `encrypted = true` (and `kms_key_id` for a customer managed key). A volume that leaves `encrypted` unset " +
      "depends on the Region's EBS encryption by default and is reported as not determined, not as a finding.",
    authority: [AWS_EBS_ENCRYPTION],
    yamlBased: false,
  },
  TF037: {
    id: "TF037",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "ECR repository allows mutable image tags",
    remediation:
      'Set `image_tag_mutability = "IMMUTABLE"`, or `"IMMUTABLE_WITH_EXCLUSION"` with an ' +
      "`image_tag_mutability_exclusion_filter` naming the few moving tags (`latest`) that must stay mutable. The " +
      "provider default is `MUTABLE`.",
    authority: [AWS_ECR_TAG_IMMUTABILITY],
    yamlBased: false,
  },
};

// Prior art credits, if any, live beside the rules in ./audit-lineage.ts (see
// core audit/prior-art.ts).
applyLineage(terraformAuditCatalog, terraformAuditLineage);
