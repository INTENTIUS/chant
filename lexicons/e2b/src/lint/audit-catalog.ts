/**
 * The e2b lexicon's chant audit catalog: metadata for the E2B post-synth
 * checks, contributed via `e2bPlugin.auditCatalog()`.
 *
 * Every check reads the chant model (`ctx.entities`), not the emitted files,
 * so they fire on `chant build` and not on an audit of a hand-written
 * `e2b.Dockerfile`.
 */

import type { RuleMeta } from "@intentius/chant/audit/catalog";

function rule(id: string, tier: RuleMeta["tier"], title: string, remediation: string): RuleMeta {
  return { id, tier, fixKind: "guidance", category: "correctness", title, remediation, yamlBased: false };
}

export const e2bAuditCatalog: Record<string, RuleMeta> = {
  E2B010: rule(
    "E2B010",
    "merge-worthy",
    "Template starts from an Alpine image",
    "Start the template from a Debian-based image, such as `node:22-bookworm`.",
  ),
  E2B011: rule(
    "E2B011",
    "merge-worthy",
    "Template name is not one E2B accepts, or two templates share it",
    "Name the template with lowercase letters, digits, dashes and underscores, and give each template its own name.",
  ),
  E2B012: rule(
    "E2B012",
    "report-only",
    "Template shows no sign of git or Node",
    "Start from a `node` image, or add a `run` step that installs git and Node.",
  ),
};
