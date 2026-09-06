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
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const terraformAuditLineage: Record<string, Lineage[]> = {};
