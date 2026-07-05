/**
 * The forgejo lexicon's chant audit catalog — metadata for its post-synth rules
 * (WFJ Forgejo rules). Contributed via forgejoPlugin.auditCatalog() (#687).
 */
import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const forgejoAuditCatalog: Record<string, RuleMeta> = {
  WFJ010: auditRule("WFJ010", "merge-worthy", "guidance", "Unresolved action reference on Forgejo", "Use an action reference Forgejo can resolve (full URL or a mirrored action).", { category: "correctness" }),
  WFJ011: auditRule("WFJ011", "merge-worthy", "guidance", "GitHub-hosted runner label with no Forgejo equivalent", "Use a runner label your Forgejo instance provides.", { category: "correctness" }),
};
