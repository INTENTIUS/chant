/**
 * The pulumi lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through `pulumiPlugin.auditCatalog()` (#4494), the way
 * the terraform lexicon contributes `terraformAuditCatalog`. A post-synth
 * check with no entry contributes nothing to `chant audit` and fails
 * `packages/core/src/audit/catalog.e2e.test.ts`.
 *
 * Every check reads the member the plugin's `buildRoots` left behind
 * (`lastMemberReport`, `lastMemberRead`), never emitted output, so
 * `yamlBased` is false. PUL001, PUL002 and PUL004 to PUL015 (#4510) are
 * correctness or best-practice findings about the graph chant reads, and
 * `report-only`: the build and the change set still run, and the fix is the
 * stack owner's, outside chant. PUL003, secrets committed in plaintext, is
 * the one security finding and the one `merge-worthy` entry; it cites no
 * authority, so the catalog's authority rules do not apply to it. None
 * carries `authority`. No other tool checks a checked-in stack export, so
 * there is no lineage to credit.
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
  PUL003: {
    id: "PUL003",
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title: "Pulumi member's stack export holds secret values in plaintext",
    remediation:
      "Export the stack again without --show-secrets (`pulumi stack export --file stack-export.json`), commit that file, and rotate every secret the plaintext export exposed in the repository's history.",
    yamlBased: false,
  },
  PUL004: {
    id: "PUL004",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export holds replaced resources whose delete failed",
    remediation:
      "Run `pulumi up` so Pulumi retries the pending delete, then export the stack again and check in the new stack-export.json.",
    yamlBased: false,
  },
  PUL005: {
    id: "PUL005",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export holds resources deleted for a replacement that was never created",
    remediation:
      "Run `pulumi up` to finish the replacement, then export the stack again and check in the new stack-export.json.",
    yamlBased: false,
  },
  PUL006: {
    id: "PUL006",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Pulumi member's stack export holds tainted resources the next update replaces",
    remediation:
      "Expect the replacement in the member's preview, or clear the mark with `pulumi state untaint <urn>` and export again.",
    yamlBased: false,
  },
  PUL007: {
    id: "PUL007",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "pulumi.member.stack names a stack other than the one the stack export was taken from",
    remediation:
      "Export the configured stack (`pulumi stack export --stack <name> --file stack-export.json`), or set pulumi.member.stack to the stack the export names.",
    yamlBased: false,
  },
  PUL008: {
    id: "PUL008",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export names more than one stack or project",
    remediation:
      "Replace stack-export.json with one `pulumi stack export` of the member's stack.",
    yamlBased: false,
  },
  PUL009: {
    id: "PUL009",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export belongs to a project other than the one Pulumi.yaml names",
    remediation:
      "Export this member's own stack again from the directory that holds its Pulumi.yaml, and check in that file.",
    yamlBased: false,
  },
  PUL010: {
    id: "PUL010",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "A resource in the Pulumi member's stack export names a parent or dependency the export does not hold",
    remediation:
      "Replace stack-export.json with a fresh `pulumi stack export`; an export Pulumi wrote holds every parent and dependency it names.",
    yamlBased: false,
  },
  PUL011: {
    id: "PUL011",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Two live resources in the Pulumi member's stack export share a URN",
    remediation:
      "Replace stack-export.json with a fresh `pulumi stack export` instead of a merged or edited one.",
    yamlBased: false,
  },
  PUL012: {
    id: "PUL012",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Pulumi member's stack export holds resources the stack reads and does not manage",
    remediation:
      "Nothing to fix in the member: read drift on these nodes as another owner's changes, and look for their owner's member in the workspace.",
    yamlBased: false,
  },
  PUL013: {
    id: "PUL013",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "Pulumi member's stack export has a deployment version other than 3",
    remediation:
      "Export the stack with the Pulumi CLI (`pulumi stack export --file stack-export.json`), which writes version 3.",
    yamlBased: false,
  },
  PUL014: {
    id: "PUL014",
    tier: "report-only",
    fixKind: "guidance",
    category: "best-practice",
    title: "Pulumi member's stack export holds no resources",
    remediation:
      "If the stack has been deployed, export it again after `pulumi up`; if it is empty on purpose, nothing to do.",
    yamlBased: false,
  },
  PUL015: {
    id: "PUL015",
    tier: "report-only",
    fixKind: "guidance",
    category: "correctness",
    title: "pulumi.member.engine says pulumi, but Pulumi.yaml names a plunge backend",
    remediation:
      "Remove `engine` from pulumi.member so the backend URL decides, or set it to \"plunge\".",
    yamlBased: false,
  },
};
