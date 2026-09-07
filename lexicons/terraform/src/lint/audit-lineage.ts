/**
 * Prior art for the terraform lexicon's audit rules: the open-source tools
 * whose checks cover the same condition, credited per rule. See
 * packages/core/src/audit/prior-art.ts for the registry, the relation
 * vocabulary, and why this is credit rather than authority. Kept by hand; the
 * prior-art sweep (scripts/prior-art-sweep.ts) reports when a credited tool's
 * index no longer lists a rule cited here.
 *
 * TF001 (no remote backend) has no entry here. Checkov's `CKV_TF_*` family
 * (checkov.io) has no rule for a missing backend block, and
 * tflint-ruleset-terraform's own rule index
 * (github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules/README.md)
 * has none either: its closest neighbors are `terraform_required_providers`
 * (unconstrained provider versions, TF002's territory, not TF001's) and
 * `terraform_workspace_remote` (a `terraform.workspace` compatibility check
 * against remote execution, a different condition than "no backend is
 * configured at all"). Ship with no lineage rather than invent a credit.
 *
 * TF101 (plan-before-apply, `lint/rules/plan-before-apply.ts`) is a source-level
 * lint rule over chant's own Op builders, not a post-synth check, so it carries
 * no `RuleMeta`/`Lineage` entry here at all: this file's `Record` only ever
 * keys post-synth check ids. Its own page section (docs/pages/lint-rules.mdx)
 * says the same thing directly: no tool anywhere models "this plan file traces
 * back to a specific preceding plan step", because that is a question about
 * chant's own DSL, not about a Terraform root.
 *
 * ## The survey registry
 *
 * #2107 ran three research passes over every serious Terraform lint, scan and
 * policy tool (1,888 lines, 222 cited URLs, attached to that issue as
 * comments). The tools and documents below are what the survey found worth
 * crediting from across that research. #2108 added none of them to
 * `PRIOR_ART`: `packages/core/src/audit/catalog.test.ts`'s "every registered
 * tool is credited" test fails on an entry no shipped rule cites yet, and
 * neither TF001 nor TF101 cites anything. #2109 (TF002-TF005) is the first to
 * draw from this list: `tflint-ruleset-terraform`, `terraform-sentinel-policies`,
 * `hashicorp-style-guide` and `aws-terraform-prescriptive-guidance` are now in
 * `PRIOR_ART`, spelled exactly as below. `checkov` and `kics` were already
 * registered (other lexicons cite them); TF004 and TF005 are the first
 * Terraform rules to. Each later rule issue adds the remaining entries it
 * needs the first time a shipped rule cites them: #2112 (TF014, TF015, TF020,
 * TF021) added `gcp-terraform-best-practices`, the last row of the table below
 * that no shipped rule had cited yet.
 *
 * Each row's Sweep note says whether `scripts/prior-art-sweep.ts` can index the
 * source and, when it cannot, why (#2219). Five of these are indexed as of
 * 2026-09-07: the three tflint rulesets, tfsec and the Sentinel policy set,
 * 311 upstream rule ids in `scripts/prior-art/snapshot.json`. The rest are
 * prose or code, so the tools they credit are re-read by hand when their
 * documents change.
 *
 * | Key | Name | URL | Licence | Kind | Note |
 * |---|---|---|---|---|---|
 * | `tflint` | tflint | https://github.com/terraform-linters/tflint | MPL-2.0 (its `terraform` package is BUSL-1.1; binaries are bound by both) | scanner | The plugin host; ships no language rules of its own. Sweep: not registered in `PRIOR_ART` (no rule cites it), so it is not swept. |
 * | `tflint-ruleset-terraform` | tflint-ruleset-terraform | https://github.com/terraform-linters/tflint-ruleset-terraform | MPL-2.0 | scanner | The official language-level ruleset, bundled into tflint. Sweep: indexed from `docs/rules/README.md`, whose table links each rule's page (20 rules). |
 * | `tflint-ruleset-redeploy` | tflint-ruleset-redeploy | https://github.com/RedeployAB/tflint-ruleset-redeploy | 0BSD | scanner | Community ruleset; richest source of language-level rules outside the official set. Sweep: indexed from `docs/rules/README.md`, same table shape (33 rules). |
 * | `tflint-ruleset-avm` | tflint-ruleset-avm | https://github.com/Azure/tflint-ruleset-avm | MIT | scanner | Azure Verified Modules conformance; two of its 33 rules are provider-agnostic. Sweep: indexed from the repository-root `RULES.md`, since `docs/` holds pages for only two rules (33 rules). |
 * | `tfsec` | tfsec | https://github.com/aquasecurity/tfsec | MIT | scanner | Historical: not archived but effectively frozen (no release since 2025-05); its docs site 404s above v0.61.x, so cite pinned repository paths (`github.com/aquasecurity/tfsec/blob/master/docs/checks/...`), not the docs site. Sweep: indexed from the root `rules.md` on `master`, a flat table of all 152 check ids, because `docs/checks` nests a directory per provider, service and check. |
 * | `trivy-checks` | trivy-checks | https://github.com/aquasecurity/trivy-checks | MIT (not the trivy scanner's own Apache-2.0; cite the checks repo's licence, not the engine's) | scanner | Where tfsec's rules live today (tfsec -> defsec -> trivy + trivy-checks). Cite rules by `long_id` (stable, human-readable); `AVD-*` ids are aliases now. Sweep: not registered in `PRIOR_ART` (no rule cites it yet) and its `long_id`s live in Rego metadata under `checks/<kind>/<provider>/<service>/`, with no flat index. |
 * | `terraform-sentinel-policies` | HashiCorp reference Sentinel policies | https://github.com/hashicorp/terraform-sentinel-policies | MPL-2.0 | specification | HashiCorp's own example policy set; ships zero rules baked into HCP Terraform itself, so treat a cited policy as a documented pattern (`specification`) unless a future entry runs it as a real check (`scanner`); the `kind` union allows either. Sweep: indexed by listing the five per-cloud directories, whose `.sentinel` filenames are the policy ids credits cite (73 policies); the repository publishes no index page. |
 * | `choudoufu` | choudoufu | https://github.com/INTENTIUS/choudoufu | MPL-2.0 | scanner | Its `internal/live/lint` package; experimental, AWS-only. Sweep: unsweepable, its rule ids are Go constants in `internal/live/lint/issue.go` and it publishes no rule index. |
 * | `hashicorp-style-guide` | HashiCorp Terraform style guide | https://developer.hashicorp.com/terraform/language/style | n/a | specification | Sweep: unsweepable, one prose page of recommendations with no rule ids; a credit quotes the sentence and links its fragment. |
 * | `gcp-terraform-best-practices` | Google Cloud Terraform best-practices series | https://docs.cloud.google.com/docs/terraform/best-practices/general-style-structure | n/a | specification | A multi-page series; cite the specific page's fragment. Sweep: unsweepable, prose across several pages with no rule ids. |
 * | `aws-terraform-prescriptive-guidance` | AWS prescriptive guidance for Terraform | https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/ | n/a | specification | Sweep: unsweepable, a prose guide whose sections carry headings rather than rule ids. |
 *
 * Deliberately excluded, per the survey: Terrascan and regula (both archived,
 * do not build on dead projects); Snyk IaC (a product, not a rule source);
 * semgrep (no SPDX id: its engine is LGPL-2.1 but its rules ship under the
 * proprietary Semgrep Rules License v1.0, which forbids redistribution; cite
 * it by name in prose if a rule's idea comes from it, never register it in
 * `PRIOR_ART` with an SPDX licence). TF008 credits semgrep by name under that
 * rule, so `PRIOR_ART` does carry the entry, with the licence spelled out
 * rather than as an SPDX id. Sweep: unsweepable, the registry publishes no
 * index and a rule id is the path of its YAML file under
 * `terraform/<provider>/<category>/`, which no single directory listing covers.
 *
 * TF024 (#2103, live root declares a backend/cloud block) credits choudoufu's
 * own `RuleStateBackend`, `internal/live/lint/issue.go` of
 * github.com/INTENTIUS/choudoufu: the identical condition, checked the same
 * way this fork checks it at `init` before any command runs. TF025 (a live
 * root's non-default `terraform.workspace`) has no entry: its workspace half
 * is refused at the CLI argument-parsing layer there
 * (`internal/command/live_mode.go`), not by a dedicated lint rule under
 * `internal/live/lint`, so there is no `Rule*` constant to point at.
 *
 * TF026 (#2106, a live root's `delete: "never"` against its `policy` block's
 * `undeclared_tagged` verb) has no entry either, the same reason TF001 has
 * none: choudoufu's own `internal/live/lint` package checks a policy block
 * for internal validity (`RulePolicyVerb`: an unrecognized or wrong-quadrant
 * verb; `RulePolicyScope`: `undeclared_untagged = "delete"` with no `scope`
 * block), never against a `delete: "never" | "owned-only" | "gated"`
 * classification, because choudoufu has no such classification — that
 * vocabulary is chant's own, shared across lexicons (`lexicons/k8s/src/op/
 * activities/kubectl.ts`'s `ApplyDeleteMode`, `packages/core/src/op/
 * activities/apply.ts`'s `DeleteMode`), applied here to a tool that does not
 * itself carry the concept. Ship with no lineage rather than invent a credit.
 *
 * TF027 (#2216, a live root's `policy` block setting `undeclared_untagged =
 * "delete"`) does have one: choudoufu's `RulePolicyScope`
 * (`internal/live/lint/policy.go`) refuses the same assignment, and issue #67
 * there makes it a lint refusal rather than a default. The relation is
 * `extends`, because choudoufu refuses it only when no `scope` block narrows
 * the purge, while chant refuses it either way: a `scope` block bounds an
 * account-wide sweep to a service, type or region, and every resource inside
 * that boundary is still one this estate never marked. "Bounded" is not
 * "owned", and owning it is the condition chant applies.
 *
 * TF028 (#2216, a live root watched by a `TerraformWatchOp` built without
 * `live: true`) has no entry. It reads a chant Op's own configuration against
 * a root's mode, and no surveyed tool has an Op model to read: choudoufu lints
 * HCL, and every tflint ruleset, tfsec/trivy-checks and the Sentinel policies
 * do the same. There is nothing upstream to credit.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

const TFSEC_V061 = "https://github.com/aquasecurity/tfsec/blob/v0.61.3/docs/checks/general/secrets";
/** tflint's official language ruleset. */
const TFLINT_RULES = "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules";
/** The community ruleset with the richest set of language rules outside the official one. */
const REDEPLOY_RULES = "https://github.com/RedeployAB/tflint-ruleset-redeploy/blob/main/docs/rules";

export const terraformAuditLineage: Record<string, Lineage[]> = {
  TF027: [
    {
      tool: "choudoufu",
      rule: "RulePolicyScope",
      url: "https://github.com/INTENTIUS/choudoufu/blob/main/internal/live/lint/policy.go",
      relation: "extends",
    },
  ],
  TF024: [
    {
      tool: "choudoufu",
      rule: "RuleStateBackend",
      url: "https://github.com/INTENTIUS/choudoufu/blob/main/internal/live/lint/issue.go",
      relation: "equivalent",
    },
  ],
  TF002: [
    {
      tool: "tflint-ruleset-terraform",
      rule: "terraform_required_providers",
      url: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules/terraform_required_providers.md",
      relation: "equivalent",
    },
    {
      tool: "terraform-sentinel-policies",
      rule: "require-all-providers-have-version-constraint",
      url: "https://github.com/hashicorp/terraform-sentinel-policies/tree/main/cloud-agnostic",
      relation: "equivalent",
    },
    {
      tool: "aws-terraform-prescriptive-guidance",
      rule: "Add automated version checks",
      url: "https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/version.html#add-automated-version-checks",
      relation: "equivalent",
    },
  ],
  // Sentinel's restrict-terraform-versions checks that required_version is
  // within an allowed range, not that it is present at all: a narrower
  // question than TF003's, so "overlaps" rather than "equivalent" (#2109).
  TF003: [
    {
      tool: "tflint-ruleset-terraform",
      rule: "terraform_required_version",
      url: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules/terraform_required_version.md",
      relation: "equivalent",
    },
    {
      tool: "terraform-sentinel-policies",
      rule: "restrict-terraform-versions",
      url: "https://github.com/hashicorp/terraform-sentinel-policies/tree/main/cloud-agnostic",
      relation: "overlaps",
    },
    {
      tool: "hashicorp-style-guide",
      rule: "Version pinning",
      url: "https://developer.hashicorp.com/terraform/language/style#version-pinning",
      relation: "overlaps",
    },
  ],
  TF004: [
    {
      tool: "tflint-ruleset-terraform",
      rule: "terraform_module_version",
      url: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules/terraform_module_version.md",
      relation: "equivalent",
    },
    {
      tool: "checkov",
      rule: "CKV_TF_2",
      url: "https://github.com/bridgecrewio/checkov/blob/main/checkov/terraform/checks/module/generic/RevisionVersionTag.py",
      relation: "equivalent",
    },
  ],
  // checkov's CKV_TF_1 accepts any `?ref=`/`&ref=` matching `[?&](ref=).*(\d\.\d).*`,
  // which a branch literally named `v1.2-dev` passes; TF005 requires a full
  // semver tag or a 40-hex SHA, so "extends" (a strict superset), not
  // "equivalent". KICS's query only matches the `git::` prefix, not the
  // github.com/bitbucket.org shorthands or scp-style sources TF005 also
  // covers, so "overlaps" (#2109).
  TF005: [
    {
      tool: "tflint-ruleset-terraform",
      rule: "terraform_module_pinned_source",
      url: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/main/docs/rules/terraform_module_pinned_source.md",
      relation: "equivalent",
    },
    {
      tool: "checkov",
      rule: "CKV_TF_1",
      url: "https://github.com/bridgecrewio/checkov/blob/main/checkov/terraform/checks/module/generic/RevisionHash.py",
      relation: "extends",
    },
    {
      tool: "kics",
      rule: "3a81fc06-566f-492a-91dd-7448e409e2cd",
      url: "https://docs.kics.io/latest/queries/terraform-queries/3a81fc06-566f-492a-91dd-7448e409e2cd/",
      relation: "overlaps",
    },
  ],
  TF006: [
    {
      tool: "tflint-ruleset-avm",
      rule: "avm_terraform_sensitive_variable_default_disallowed",
      url: "https://github.com/Azure/tflint-ruleset-avm/blob/main/docs/basic/avm_terraform_sensitive_variable_default_disallowed.md",
      relation: "equivalent",
    },
  ],
  TF007: [
    { tool: "tfsec", rule: "general-secrets-sensitive-in-variable", url: `${TFSEC_V061}/sensitive-in-variable.md`, relation: "equivalent" },
    { tool: "tfsec", rule: "general-secrets-sensitive-in-local", url: `${TFSEC_V061}/sensitive-in-local.md`, relation: "equivalent" },
  ],
  TF008: [
    { tool: "checkov", rule: "CKV_AWS_41", url: "https://www.checkov.io/5.Policy%20Index/terraform.html", relation: "overlaps" },
    { tool: "kics", rule: "d7b9d850-3e06-4a75-852f-c46c2e92240b", url: "https://docs.kics.io/latest/queries/terraform-queries/aws/d7b9d850-3e06-4a75-852f-c46c2e92240b/", relation: "overlaps" },
    {
      tool: "semgrep",
      rule: "terraform.aws.security.aws-provider-static-credentials",
      url: "https://github.com/semgrep/semgrep-rules/blob/develop/terraform/aws/security/aws-provider-static-credentials.yaml",
      relation: "overlaps",
    },
  ],
  TF009: [
    {
      tool: "hashicorp-style-guide",
      rule: "Variables: for sensitive variables, such as passwords and private keys, set the sensitive parameter to true",
      url: "https://developer.hashicorp.com/terraform/language/style#variables",
      relation: "equivalent",
    },
  ],
  TF010: [
    { tool: "tflint-ruleset-terraform", rule: "terraform_typed_variables", url: `${TFLINT_RULES}/terraform_typed_variables.md`, relation: "equivalent" },
    { tool: "kics", rule: "fc5109bf-01fd-49fb-8bde-4492b543c34a", url: "https://docs.kics.io/latest/queries/terraform-queries/fc5109bf-01fd-49fb-8bde-4492b543c34a/", relation: "equivalent" },
  ],
  TF011: [
    { tool: "tflint-ruleset-terraform", rule: "terraform_documented_variables", url: `${TFLINT_RULES}/terraform_documented_variables.md`, relation: "equivalent" },
    { tool: "kics", rule: "2a153952-2544-4687-bcc9-cc8fea814a9b", url: "https://docs.kics.io/latest/queries/terraform-queries/2a153952-2544-4687-bcc9-cc8fea814a9b/", relation: "equivalent" },
    {
      tool: "terraform-sentinel-policies",
      rule: "validate-variables-have-descriptions",
      url: "https://github.com/hashicorp/terraform-sentinel-policies/blob/main/cloud-agnostic/validate-variables-have-descriptions.sentinel",
      relation: "equivalent",
    },
  ],
  TF012: [
    { tool: "tflint-ruleset-terraform", rule: "terraform_documented_outputs", url: `${TFLINT_RULES}/terraform_documented_outputs.md`, relation: "equivalent" },
    { tool: "kics", rule: "59312e8a-a64e-41e7-a252-618533dd1ea8", url: "https://docs.kics.io/latest/queries/terraform-queries/59312e8a-a64e-41e7-a252-618533dd1ea8/", relation: "equivalent" },
  ],
  TF013: [
    { tool: "tflint-ruleset-redeploy", rule: "terraform_ignore_changes_all", url: `${REDEPLOY_RULES}/terraform_ignore_changes_all.md`, relation: "equivalent" },
  ],
  TF014: [
    {
      tool: "tflint-ruleset-avm",
      rule: "avm_terraform_provider_block_disallowed",
      url: "https://github.com/Azure/tflint-ruleset-avm/blob/main/docs/basic/avm_terraform_provider_block_disallowed.md",
      relation: "equivalent",
    },
    {
      tool: "gcp-terraform-best-practices",
      rule: "Build reusable modules: modules must not configure providers",
      url: "https://docs.cloud.google.com/docs/terraform/best-practices/general-style-structure#reusable-modules",
      relation: "equivalent",
    },
    {
      tool: "aws-terraform-prescriptive-guidance",
      rule: "Structure: declare provider configurations in the root module",
      url: "https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/structure.html",
      relation: "equivalent",
    },
  ],
  // TF015 has no scanner to credit: no ruleset in the survey checks for a
  // backend or cloud block inside a child module.
  // tflint-ruleset-terraform's index has nothing about backends at all,
  // Redeploy's has nothing either, and AVM's module rules stop at the
  // provider block TF014 credits. What states the rule is Google Cloud's
  // reusable-modules guide, so that document is the single credit here, and
  // the page section says plainly that the credit is a document rather than
  // a tool (#2112).
  TF015: [
    {
      tool: "gcp-terraform-best-practices",
      rule: "Build reusable modules: state configuration belongs to the root module",
      url: "https://docs.cloud.google.com/docs/terraform/best-practices/general-style-structure#reusable-modules",
      relation: "equivalent",
    },
  ],
  TF016: [
    // `overlaps`, not `equivalent`: tflint reports the same `x = "${y}"` form
    // and also the object-key case (`"${var.k}" = v`), which this rule leaves
    // alone. See tf016.ts.
    { tool: "tflint-ruleset-terraform", rule: "terraform_deprecated_interpolation", url: `${TFLINT_RULES}/terraform_deprecated_interpolation.md`, relation: "overlaps" },
  ],
  TF017: [
    { tool: "tflint-ruleset-redeploy", rule: "terraform_module_depends_on", url: `${REDEPLOY_RULES}/terraform_module_depends_on.md`, relation: "equivalent" },
  ],
  TF018: [
    { tool: "tflint-ruleset-redeploy", rule: "terraform_output_resource", url: `${REDEPLOY_RULES}/terraform_output_resource.md`, relation: "equivalent" },
  ],
  TF019: [
    { tool: "tflint-ruleset-redeploy", rule: "terraform_redundant_default", url: `${REDEPLOY_RULES}/terraform_redundant_default.md`, relation: "equivalent" },
  ],
  TF020: [
    // `overlaps`: tflint evaluates expressions and reports the same four
    // kinds of declaration; chant's index is a string scan over hcl2json's
    // preserved expression strings, so it is generous where tflint is exact
    // (see hcl/references.ts and tf020.ts).
    {
      tool: "tflint-ruleset-terraform",
      rule: "terraform_unused_declarations",
      url: `${TFLINT_RULES}/terraform_unused_declarations.md`,
      relation: "overlaps",
    },
  ],
  TF021: [
    // Redeploy reports every `count` over a collection; TF021 reports only
    // the ones that build an identity out of `count.index`, which is a
    // strict subset, hence `overlaps` on both credits rather than
    // `equivalent`. choudoufu's own rule is the survey's deepest reading of
    // the identity-bearing question (#2112).
    {
      tool: "tflint-ruleset-redeploy",
      rule: "terraform_prefer_for_each",
      url: `${REDEPLOY_RULES}/terraform_prefer_for_each.md`,
      relation: "overlaps",
    },
    {
      tool: "choudoufu",
      rule: "RuleCountIndex",
      url: "https://github.com/INTENTIUS/choudoufu/blob/main/internal/live/lint/count_index.go",
      relation: "overlaps",
    },
    {
      tool: "hashicorp-style-guide",
      rule: "Resources: use for_each for a dynamic resource count",
      url: "https://developer.hashicorp.com/terraform/language/style#dynamic-resource-count",
      relation: "overlaps",
    },
  ],
  TF022: [
    // tfsec consolidated its three `general/secrets` checks into
    // `no-plaintext-exposure` in v1, which is the one still in the repository's
    // `master` docs; `overlaps` because that consolidation also covers the
    // variable and locals cases TF007 reports separately.
    {
      tool: "tfsec",
      rule: "general-secrets-no-plaintext-exposure",
      url: "https://github.com/aquasecurity/tfsec/blob/master/docs/checks/general/secrets/no-plaintext-exposure/index.md",
      relation: "overlaps",
    },
    { tool: "kics", rule: "a88baa34-e2ad-44ea-ad6f-8cac87bc7c71", url: "https://docs.kics.io/latest/secrets/", relation: "overlaps" },
  ],
};
