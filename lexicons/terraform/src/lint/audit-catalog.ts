/**
 * The terraform lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through `terraformPlugin.auditCatalog()` (#687, #1346).
 * Every post-synth check needs an entry or it contributes nothing to
 * `chant audit`, silently, and `packages/core/src/audit/catalog.test.ts` fails.
 *
 * TF001, TF024 and TF025 all read the chant model (`ctx.entities`), never
 * emitted output, so `yamlBased` is false for all three. Prior-art lineage
 * lives in ./audit-lineage.ts.
 */
import type { Authority, RuleMeta } from "@intentius/chant/audit/catalog";
import { applyLineage } from "@intentius/chant/audit/catalog";
import { terraformAuditLineage } from "./audit-lineage";

const HASHICORP_STYLE_VARIABLES: Authority = {
  name: "HashiCorp Terraform style guide — Variables",
  url: "https://developer.hashicorp.com/terraform/language/style#variables",
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
};

// Prior art credits, if any, live beside the rules in ./audit-lineage.ts (see
// core audit/prior-art.ts).
applyLineage(terraformAuditCatalog, terraformAuditLineage);
