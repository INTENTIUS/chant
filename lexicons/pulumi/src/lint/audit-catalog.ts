/**
 * The pulumi lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through `pulumiPlugin.auditCatalog()` (#4494), the way
 * the terraform lexicon contributes `terraformAuditCatalog`. A post-synth
 * check with no entry contributes nothing to `chant audit` and fails
 * `packages/core/src/audit/catalog.e2e.test.ts`.
 *
 * Both checks read the member report the plugin's `buildRoots` left behind
 * (`lastMemberReport`), never emitted output, so `yamlBased` is false. Both
 * are correctness findings about the graph chant reads, with no security
 * authority to cite, so neither carries `authority`. Both are `report-only`:
 * the build and the change set still run, and the fix is the stack owner's,
 * outside chant. No other tool checks a checked-in stack export, so there is
 * no lineage to credit.
 */
import type { RuleMeta } from "@intentius/chant/audit/catalog";

export const pulumiAuditCatalog: Record<string, RuleMeta> = {
  PUL001: {
    id: "PUL001",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member has no readable stack-export.json, so it has no nodes in the graph",
    remediation:
      "Run `pulumi stack export --file stack-export.json` in the member's directory (beside Pulumi.yaml) " +
      "and check the file in, so the graph can link to the member's resources and drift records land on nodes.",
    yamlBased: false,
  },
  PUL002: {
    id: "PUL002",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export records pending operations from an interrupted update",
    remediation:
      "Resolve the pending operations with `pulumi refresh` (or `pulumi stack export`, edit, " +
      "`pulumi stack import`), then export the stack again and check in the new stack-export.json.",
    yamlBased: false,
  },
};
