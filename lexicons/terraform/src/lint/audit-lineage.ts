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
 * crediting from across that research. This issue (#2108) adds none of them to
 * `PRIOR_ART`. `packages/core/src/audit/catalog.test.ts`'s "every registered
 * tool is credited" test fails on an entry no shipped rule cites yet, and
 * neither TF001 nor TF101 cites anything. Each later rule issue (#2109, #2110,
 * ...) adds the entries it needs from this list, spelled exactly as below, the
 * first time a shipped rule cites them.
 *
 * | Key | Name | URL | Licence | Kind | Note |
 * |---|---|---|---|---|---|
 * | `tflint` | tflint | https://github.com/terraform-linters/tflint | MPL-2.0 (its `terraform` package is BUSL-1.1; binaries are bound by both) | scanner | The plugin host; ships no language rules of its own. |
 * | `tflint-ruleset-terraform` | tflint-ruleset-terraform | https://github.com/terraform-linters/tflint-ruleset-terraform | MPL-2.0 | scanner | The official language-level ruleset, bundled into tflint. |
 * | `tflint-ruleset-redeploy` | tflint-ruleset-redeploy | https://github.com/RedeployAB/tflint-ruleset-redeploy | 0BSD | scanner | Community ruleset; richest source of language-level rules outside the official set. |
 * | `tflint-ruleset-avm` | tflint-ruleset-avm | https://github.com/Azure/tflint-ruleset-avm | MIT | scanner | Azure Verified Modules conformance; two of its 33 rules are provider-agnostic. |
 * | `tfsec` | tfsec | https://github.com/aquasecurity/tfsec | MIT | scanner | Historical: not archived but effectively frozen (no release since 2025-05); its docs site 404s above v0.61.x, so cite pinned repository paths (`github.com/aquasecurity/tfsec/blob/master/docs/checks/...`), not the docs site. |
 * | `trivy-checks` | trivy-checks | https://github.com/aquasecurity/trivy-checks | MIT (not the trivy scanner's own Apache-2.0; cite the checks repo's licence, not the engine's) | scanner | Where tfsec's rules live today (tfsec -> defsec -> trivy + trivy-checks). Cite rules by `long_id` (stable, human-readable); `AVD-*` ids are aliases now. |
 * | `terraform-sentinel-policies` | HashiCorp reference Sentinel policies | https://github.com/hashicorp/terraform-sentinel-policies | MPL-2.0 | specification | HashiCorp's own example policy set; ships zero rules baked into HCP Terraform itself, so treat a cited policy as a documented pattern (`specification`) unless a future entry runs it as a real check (`scanner`); the `kind` union allows either. |
 * | `choudoufu` | choudoufu | https://github.com/INTENTIUS/choudoufu | MPL-2.0 | scanner | Its `internal/live/lint` package; experimental, AWS-only. |
 * | `hashicorp-style-guide` | HashiCorp Terraform style guide | https://developer.hashicorp.com/terraform/language/style | n/a | specification | |
 * | `gcp-terraform-best-practices` | Google Cloud Terraform best-practices series | https://docs.cloud.google.com/docs/terraform/best-practices/general-style-structure | n/a | specification | A multi-page series; cite the specific page's fragment. |
 * | `aws-terraform-prescriptive-guidance` | AWS prescriptive guidance for Terraform | https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/ | n/a | specification | |
 *
 * Deliberately excluded, per the survey: Terrascan and regula (both archived,
 * do not build on dead projects); Snyk IaC (a product, not a rule source);
 * semgrep (no SPDX id: its engine is LGPL-2.1 but its rules ship under the
 * proprietary Semgrep Rules License v1.0, which forbids redistribution; cite
 * it by name in prose if a rule's idea comes from it, never register it in
 * `PRIOR_ART` with an SPDX licence).
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const terraformAuditLineage: Record<string, Lineage[]> = {};
