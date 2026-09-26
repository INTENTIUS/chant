/**
 * The systemone lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed via systemonePlugin.auditCatalog(). Every post-synth
 * check has an entry, or the check contributes nothing to `chant audit`.
 */
import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const systemoneAuditCatalog: Record<string, RuleMeta> = {
  SYS010: auditRule(
    "SYS010",
    "merge-worthy",
    "guidance",
    "Backend key sent over plain HTTP",
    "Use an https:// URL for the backend, or a broker listening on loopback that adds the key itself.",
    { category: "security" },
  ),
};
