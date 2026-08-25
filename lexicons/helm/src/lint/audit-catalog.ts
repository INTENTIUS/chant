/**
 * The helm lexicon's chant audit catalog — metadata for its post-synth rules
 * (WHM Helm-chart rules). Contributed via helmPlugin.auditCatalog() (#687).
 */
import { auditRule, K8S_PSS, K8S_SECRETS, SCORECARD_PINNED, type RuleMeta } from "@intentius/chant/audit/catalog";

export const helmAuditCatalog: Record<string, RuleMeta> = {
  WHM005: auditRule("WHM005", "report-only", "guidance", "Sub-chart wrapper with no templates", "Deploy the upstream chart directly instead of an empty wrapper.", { category: "best-practice" }),
  WHM101: auditRule("WHM101", "merge-worthy", "guidance", "Chart.yaml missing required fields", "Set apiVersion (v2), name, and version in Chart.yaml.", { category: "correctness" }),
  WHM102: auditRule("WHM102", "report-only", "guidance", "Missing values.schema.json", "Add a values.schema.json to validate values.", { category: "best-practice" }),
  WHM103: auditRule("WHM103", "merge-worthy", "guidance", "Invalid Go template syntax", "Fix the unbalanced template braces.", { category: "correctness" }),
  WHM104: auditRule("WHM104", "report-only", "guidance", "Missing NOTES.txt", "Add templates/NOTES.txt for application charts.", { category: "best-practice" }),
  WHM105: auditRule("WHM105", "report-only", "guidance", "Missing _helpers.tpl", "Add templates/_helpers.tpl.", { category: "best-practice" }),
  WHM201: auditRule("WHM201", "report-only", "guidance", "Missing standard Helm labels", "Add the recommended app.kubernetes.io labels.", { category: "best-practice" }),
  WHM202: auditRule("WHM202", "report-only", "guidance", "Hook weights undefined", "Define hook weights when multiple hooks exist.", { category: "best-practice" }),
  WHM203: auditRule("WHM203", "report-only", "guidance", "Undocumented values", "Document values via schema or comments.", { category: "best-practice" }),
  WHM204: auditRule("WHM204", "report-only", "guidance", "Dependencies pinned, not ranged", "Use semver ranges for chart dependencies.", { category: "best-practice" }),
  WHM301: auditRule("WHM301", "report-only", "guidance", "No Helm test", "Add at least one Helm test for application charts.", { category: "best-practice" }),
  WHM302: auditRule("WHM302", "report-only", "guidance", "Container resources not set", "Set limits/requests via values or defaults.", { category: "best-practice" }),
  WHM401: auditRule("WHM401", "merge-worthy", "guidance", "Container image uses :latest or no tag", "Pin the image to an explicit version tag.", { authority: [SCORECARD_PINNED] }),
  WHM402: auditRule("WHM402", "merge-worthy", "guidance", "Container may run as root", "Set runAsNonRoot in the security context.", { authority: [K8S_PSS] }),
  WHM403: auditRule("WHM403", "merge-worthy", "guidance", "Root filesystem writable", "Set readOnlyRootFilesystem.", { authority: [K8S_PSS] }),
  WHM404: auditRule("WHM404", "merge-worthy", "guidance", "Privileged container", "Remove privileged mode.", { authority: [K8S_PSS] }),
  WHM405: auditRule("WHM405", "report-only", "guidance", "Resource specs missing cpu/memory", "Set cpu and memory in limits/requests.", { category: "best-practice" }),
  WHM406: auditRule("WHM406", "report-only", "guidance", "CRDs in crds/ are never upgraded", "Manage CRD upgrades outside Helm or via a separate chart.", { category: "best-practice" }),
  WHM407: auditRule("WHM407", "merge-worthy", "guidance", "Inline Secret data", "Use ExternalSecret/SealedSecret instead of inline Secret data.", { authority: [K8S_SECRETS] }),
  WHM501: auditRule("WHM501", "report-only", "guidance", "Unused values key", "Remove values defined but never referenced.", { category: "best-practice" }),
  WHM502: auditRule("WHM502", "merge-worthy", "guidance", "Deprecated/invalid Kubernetes API version", "Update to a supported apiVersion.", { category: "correctness" }),
  WHM503: auditRule("WHM503", "merge-worthy", "guidance", "Pinned render carries Secret data", "Declare the value with runtimeSlot() or replace the Secret with HelmExternalSecret.", { authority: [K8S_SECRETS] }),
};
