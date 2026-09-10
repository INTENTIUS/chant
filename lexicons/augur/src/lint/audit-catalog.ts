/**
 * The augur lexicon's chant audit catalog — metadata for its post-synth
 * checks, contributed via `augurPlugin.auditCatalog()` (#687, #1346). Every
 * post-synth check has an entry, or the check contributes nothing to
 * `chant audit`, silently.
 */
import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const augurAuditCatalog: Record<string, RuleMeta> = {
  AUG101: auditRule(
    "AUG101",
    "merge-worthy",
    "guidance",
    "Two profiles name the same traffic level",
    "Give each profile a level of its own, or declare one — identical levels are the same request, asked twice.",
    { category: "correctness" },
  ),
};
