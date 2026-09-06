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
import type { RuleMeta } from "@intentius/chant/audit/catalog";
import { applyLineage } from "@intentius/chant/audit/catalog";
import { terraformAuditLineage } from "./audit-lineage";

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
};

// Prior art credits, if any, live beside the rules in ./audit-lineage.ts (see
// core audit/prior-art.ts).
applyLineage(terraformAuditCatalog, terraformAuditLineage);
