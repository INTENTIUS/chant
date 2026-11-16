/**
 * The prow lexicon's chant audit catalog: metadata for its post-synth
 * checks, contributed through prowPlugin.auditCatalog(). Every post-synth
 * check has an entry.
 */
import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const prowAuditCatalog: Record<string, RuleMeta> = {
  PROW101: auditRule("PROW101", "merge-worthy", "guidance", "Two jobs with one name in a repository", "Rename one of the jobs, or give each its own branches.", { category: "correctness" }),
  PROW102: auditRule("PROW102", "merge-worthy", "guidance", "Periodic without exactly one schedule", "Set one of interval, cron and minimum_interval on the periodic.", { category: "correctness" }),
  PROW103: auditRule("PROW103", "merge-worthy", "guidance", "Kubernetes job without a pod spec", "Give the job a spec with at least one container.", { category: "correctness" }),
  PROW104: auditRule("PROW104", "report-only", "guidance", "Presubmit reads a Secret", "Move the credential to a postsubmit or a periodic, or keep it out of the process that runs the pull request's code.", { category: "security" }),
  PROW105: auditRule("PROW105", "report-only", "guidance", "Presubmit on a build cluster that holds credentials", "Run presubmits on a build cluster where no job holds a Secret or a cloud identity.", { category: "security" }),
  PROW106: auditRule("PROW106", "merge-worthy", "guidance", "always_run beside a change filter", "Keep one of always_run, run_if_changed and skip_if_only_changed.", { category: "correctness" }),
};
