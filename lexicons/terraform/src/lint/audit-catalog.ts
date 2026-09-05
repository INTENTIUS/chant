/**
 * The terraform lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through `terraformPlugin.auditCatalog()` (#687, #1346).
 * Every post-synth check needs an entry or it contributes nothing to
 * `chant audit`, silently, and `packages/core/src/audit/catalog.test.ts` fails.
 *
 * TF001 reads the chant model (`ctx.entities`), never emitted output, so
 * `yamlBased` is false. Prior-art lineage lands with the rest of the rules in
 * #2085.
 */
import type { RuleMeta } from "@intentius/chant/audit/catalog";

export const terraformAuditCatalog: Record<string, RuleMeta> = {
  TF001: {
    id: "TF001",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Root module declares no remote backend",
    remediation:
      'Add a `backend "<type>"` block (s3, gcs, azurerm, http) or a `cloud {}` block to the root ' +
      "module's terraform block, then `terraform init -migrate-state`.",
    yamlBased: false,
  },
};
