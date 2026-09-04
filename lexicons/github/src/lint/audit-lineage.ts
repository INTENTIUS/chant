/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const githubAuditLineage: Record<string, Lineage[]> = {
  GHA009: [
    { tool: "actionlint", rule: "Unexpected empty mappings", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#unexpected-empty-mappings", relation: "overlaps" },
  ],
  GHA011: [
    { tool: "actionlint", rule: "Job dependencies validation", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#job-dependencies-validation", relation: "equivalent" },
  ],
  GHA013: [
    { tool: "poutine", rule: "default_permissions_on_risky_events", url: "https://boostsecurityio.github.io/poutine/rules/default_permissions_on_risky_events/", relation: "overlaps" },
    { tool: "zizmor", rule: "excessive-permissions", url: "https://docs.zizmor.sh/audits/#excessive-permissions", relation: "overlaps" },
    { tool: "scorecard", rule: "Token-Permissions", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions", relation: "overlaps" },
  ],
  GHA017: [
    { tool: "zizmor", rule: "excessive-permissions", url: "https://docs.zizmor.sh/audits/#excessive-permissions", relation: "overlaps" },
    { tool: "scorecard", rule: "Token-Permissions", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions", relation: "overlaps" },
  ],
  GHA018: [
    { tool: "scorecard", rule: "Dangerous-Workflow", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#dangerous-workflow", relation: "overlaps" },
    { tool: "octoscan", rule: "dangerous-checkout", url: "https://github.com/synacktiv/octoscan#dangerous-checkout", relation: "overlaps" },
    { tool: "poutine", rule: "untrusted_checkout_exec", url: "https://boostsecurityio.github.io/poutine/rules/untrusted_checkout_exec/", relation: "overlaps" },
  ],
  GHA019: [
    { tool: "actionlint", rule: "Job dependencies validation", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#job-dependencies-validation", relation: "equivalent" },
  ],
  GHA021: [
    { tool: "zizmor", rule: "unpinned-uses", url: "https://docs.zizmor.sh/audits/#unpinned-uses", relation: "overlaps" },
    { tool: "scorecard", rule: "Pinned-Dependencies", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies", relation: "overlaps" },
  ],
  GHA023: [
    { tool: "actionlint", rule: "Check deprecated workflow commands", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#check-deprecated-workflow-commands", relation: "overlaps" },
  ],
  GHA024: [
    { tool: "zizmor", rule: "concurrency-limits", url: "https://docs.zizmor.sh/audits/#concurrency-limits", relation: "overlaps" },
  ],
  GHA025: [
    { tool: "zizmor", rule: "dangerous-triggers", url: "https://docs.zizmor.sh/audits/#dangerous-triggers", relation: "overlaps" },
  ],
  GHA026: [
    { tool: "zizmor", rule: "secrets-outside-env", url: "https://docs.zizmor.sh/audits/#secrets-outside-env", relation: "equivalent" },
  ],
  GHA028: [
    { tool: "actionlint", rule: "Missing required keys and key duplicates", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#missing-required-keys-and-key-duplicates", relation: "overlaps" },
  ],
  GHA029: [
    { tool: "zizmor", rule: "unpinned-uses", url: "https://docs.zizmor.sh/audits/#unpinned-uses", relation: "overlaps" },
    { tool: "scorecard", rule: "Pinned-Dependencies", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies", relation: "overlaps" },
  ],
  GHA030: [
    { tool: "zizmor", rule: "unpinned-images", url: "https://docs.zizmor.sh/audits/#unpinned-images", relation: "overlaps" },
  ],
  GHA031: [
    { tool: "zizmor", rule: "typosquat-uses", url: "https://docs.zizmor.sh/audits/#typosquat-uses", relation: "equivalent" },
  ],
  GHA032: [
    { tool: "zizmor", rule: "archived-uses", url: "https://docs.zizmor.sh/audits/#archived-uses", relation: "overlaps" },
    { tool: "zizmor", rule: "known-vulnerable-actions", url: "https://docs.zizmor.sh/audits/#known-vulnerable-actions", relation: "overlaps" },
  ],
  GHA033: [
    { tool: "zizmor", rule: "excessive-permissions", url: "https://docs.zizmor.sh/audits/#excessive-permissions", relation: "overlaps" },
    { tool: "scorecard", rule: "Token-Permissions", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions", relation: "overlaps" },
  ],
  GHA034: [
    { tool: "zizmor", rule: "excessive-permissions", url: "https://docs.zizmor.sh/audits/#excessive-permissions", relation: "overlaps" },
    { tool: "scorecard", rule: "Token-Permissions", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions", relation: "overlaps" },
  ],
  GHA036: [
    { tool: "zizmor", rule: "template-injection", url: "https://docs.zizmor.sh/audits/#template-injection", relation: "equivalent" },
    { tool: "poutine", rule: "injection", url: "https://boostsecurityio.github.io/poutine/rules/injection/", relation: "equivalent" },
    { tool: "actionlint", rule: "Script injection by potentially untrusted inputs", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#script-injection-by-potentially-untrusted-inputs", relation: "equivalent" },
    { tool: "octoscan", rule: "expression-injection", url: "https://github.com/synacktiv/octoscan#expression-injection", relation: "equivalent" },
    { tool: "scorecard", rule: "Dangerous-Workflow", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#dangerous-workflow", relation: "overlaps" },
  ],
  GHA037: [
    { tool: "zizmor", rule: "github-env", url: "https://docs.zizmor.sh/audits/#github-env", relation: "equivalent" },
    { tool: "octoscan", rule: "dangerous-write", url: "https://github.com/synacktiv/octoscan#dangerous-write", relation: "overlaps" },
  ],
  GHA038: [
    { tool: "scorecard", rule: "Dangerous-Workflow", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#dangerous-workflow", relation: "overlaps" },
    { tool: "octoscan", rule: "dangerous-checkout", url: "https://github.com/synacktiv/octoscan#dangerous-checkout", relation: "overlaps" },
  ],
  GHA039: [
    { tool: "zizmor", rule: "bot-conditions", url: "https://docs.zizmor.sh/audits/#bot-conditions", relation: "overlaps" },
    { tool: "octoscan", rule: "bot-check", url: "https://github.com/synacktiv/octoscan#bot-check", relation: "overlaps" },
    { tool: "poutine", rule: "confused_deputy_auto_merge", url: "https://boostsecurityio.github.io/poutine/rules/confused_deputy_auto_merge/", relation: "overlaps" },
  ],
  GHA040: [
    { tool: "poutine", rule: "pr_runs_on_self_hosted", url: "https://boostsecurityio.github.io/poutine/rules/pr_runs_on_self_hosted/", relation: "equivalent" },
    { tool: "zizmor", rule: "self-hosted-runner", url: "https://docs.zizmor.sh/audits/#self-hosted-runner", relation: "overlaps" },
    { tool: "octoscan", rule: "runner-label", url: "https://github.com/synacktiv/octoscan#runner-label", relation: "overlaps" },
  ],
  GHA041: [
    { tool: "zizmor", rule: "secrets-inherit", url: "https://docs.zizmor.sh/audits/#secrets-inherit", relation: "equivalent" },
  ],
  GHA042: [
    { tool: "zizmor", rule: "overprovisioned-secrets", url: "https://docs.zizmor.sh/audits/#overprovisioned-secrets", relation: "equivalent" },
    { tool: "poutine", rule: "job_all_secrets", url: "https://boostsecurityio.github.io/poutine/rules/job_all_secrets/", relation: "equivalent" },
  ],
  GHA043: [
    { tool: "zizmor", rule: "secrets-outside-env", url: "https://docs.zizmor.sh/audits/#secrets-outside-env", relation: "equivalent" },
  ],
  GHA044: [
    { tool: "zizmor", rule: "hardcoded-container-credentials", url: "https://docs.zizmor.sh/audits/#hardcoded-container-credentials", relation: "equivalent" },
    { tool: "actionlint", rule: "Hardcoded credentials", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#hardcoded-credentials", relation: "equivalent" },
    { tool: "octoscan", rule: "credentials", url: "https://github.com/synacktiv/octoscan#credentials", relation: "equivalent" },
  ],
  GHA046: [
    { tool: "actionlint", rule: "Constant conditions at `if:`", url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md#constant-conditions-at-if", relation: "equivalent" },
    { tool: "zizmor", rule: "unsound-condition", url: "https://docs.zizmor.sh/audits/#unsound-condition", relation: "overlaps" },
    { tool: "poutine", rule: "if_always_true", url: "https://boostsecurityio.github.io/poutine/rules/if_always_true/", relation: "overlaps" },
  ],
  GHA047: [
    { tool: "zizmor", rule: "unsound-contains", url: "https://docs.zizmor.sh/audits/#unsound-contains", relation: "equivalent" },
  ],
  GHA048: [
    { tool: "zizmor", rule: "obfuscation", url: "https://docs.zizmor.sh/audits/#obfuscation", relation: "overlaps" },
  ],
  GHA049: [
    { tool: "zizmor", rule: "artipacked", url: "https://docs.zizmor.sh/audits/#artipacked", relation: "equivalent" },
    { tool: "octoscan", rule: "dangerous-artefact", url: "https://github.com/synacktiv/octoscan#dangerous-artefact", relation: "overlaps" },
  ],
  GHA050: [
    { tool: "zizmor", rule: "cache-poisoning", url: "https://docs.zizmor.sh/audits/#cache-poisoning", relation: "overlaps" },
  ],
  GHA051: [
    { tool: "zizmor", rule: "use-trusted-publishing", url: "https://docs.zizmor.sh/audits/#use-trusted-publishing", relation: "overlaps" },
  ],
  GHA052: [
    { tool: "poutine", rule: "unverified_script_exec", url: "https://boostsecurityio.github.io/poutine/rules/unverified_script_exec/", relation: "equivalent" },
    { tool: "scorecard", rule: "Pinned-Dependencies", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies", relation: "overlaps" },
  ],
  GHA053: [
    { tool: "zizmor", rule: "insecure-commands", url: "https://docs.zizmor.sh/audits/#insecure-commands", relation: "equivalent" },
    { tool: "octoscan", rule: "unsecure-commands", url: "https://github.com/synacktiv/octoscan#unsecure-commands", relation: "equivalent" },
  ],
  GHA054: [
    { tool: "zizmor", rule: "misfeature", url: "https://docs.zizmor.sh/audits/#misfeature", relation: "overlaps" },
  ],
  GHA055: [
    { tool: "zizmor", rule: "superfluous-actions", url: "https://docs.zizmor.sh/audits/#superfluous-actions", relation: "overlaps" },
  ],
  GHA056: [
    { tool: "zizmor", rule: "anonymous-definition", url: "https://docs.zizmor.sh/audits/#anonymous-definition", relation: "overlaps" },
  ],
  GHA057: [
    { tool: "zizmor", rule: "dependabot-execution", url: "https://docs.zizmor.sh/audits/#dependabot-execution", relation: "equivalent" },
  ],
  GHA058: [
    { tool: "zizmor", rule: "dependabot-cooldown", url: "https://docs.zizmor.sh/audits/#dependabot-cooldown", relation: "equivalent" },
  ],
  GHA059: [
    { tool: "zizmor", rule: "ref-version-mismatch", url: "https://docs.zizmor.sh/audits/#ref-version-mismatch", relation: "equivalent" },
  ],
  GHA060: [
    { tool: "zizmor", rule: "github-app", url: "https://docs.zizmor.sh/audits/#github-app", relation: "overlaps" },
  ],
  GHA061: [
    { tool: "zizmor", rule: "forbidden-uses", url: "https://docs.zizmor.sh/audits/#forbidden-uses", relation: "equivalent" },
  ],
  GHA062: [
    { tool: "zizmor", rule: "known-vulnerable-actions", url: "https://docs.zizmor.sh/audits/#known-vulnerable-actions", relation: "equivalent" },
    { tool: "poutine", rule: "known_vulnerability_in_build_component", url: "https://boostsecurityio.github.io/poutine/rules/known_vulnerability_in_build_component/", relation: "equivalent" },
    { tool: "octoscan", rule: "known-vulnerability", url: "https://github.com/synacktiv/octoscan#known-vulnerability", relation: "equivalent" },
    { tool: "scorecard", rule: "Vulnerabilities", url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#vulnerabilities", relation: "overlaps" },
  ],
  GHA068: [
    { tool: "zizmor", rule: "concurrency-limits", url: "https://docs.zizmor.sh/audits/#concurrency-limits", relation: "overlaps" },
  ],
};
