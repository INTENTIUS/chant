/**
 * The gitlab lexicon's chant audit catalog — metadata for its post-synth rules
 * (WGL GitLab CI rules). Contributed via gitlabPlugin.auditCatalog() (#687).
 */
import { auditRule, GH_INJECTION, GH_OIDC, GH_PWN, GH_SECRETS, SCORECARD_PINNED, type RuleMeta, applyLineage } from "@intentius/chant/audit/catalog";
import { gitlabAuditLineage } from "./audit-lineage";

export const gitlabAuditCatalog: Record<string, RuleMeta> = {
  WGL010: auditRule("WGL010", "merge-worthy", "guidance", "Job references an undefined stage", "Add the stage to `stages:` or fix the job's `stage:`.", { category: "correctness" }),
  WGL011: auditRule("WGL011", "merge-worthy", "guidance", "Job rules always evaluate to never", "Fix the `rules:` so the job can run; it is currently unreachable.", { category: "correctness" }),
  WGL012: auditRule("WGL012", "report-only", "guidance", "Deprecated property", "Replace the deprecated GitLab CI property.", { category: "best-practice" }),
  WGL013: auditRule("WGL013", "merge-worthy", "guidance", "Invalid needs target", "Fix the dangling/self `needs:` reference.", { category: "correctness" }),
  WGL014: auditRule("WGL014", "merge-worthy", "guidance", "Invalid extends target", "Point `extends:` at a template that exists in the pipeline.", { category: "correctness" }),
  WGL015: auditRule("WGL015", "merge-worthy", "guidance", "Circular needs chain", "Break the cycle in the job dependency graph.", { category: "correctness" }),
  WGL016: auditRule("WGL016", "merge-worthy", "guidance", "Hardcoded secret in variables", "Move the secret out of `variables:` into a masked/protected CI variable and rotate it.", { authority: [GH_SECRETS] }),
  WGL017: auditRule("WGL017", "merge-worthy", "guidance", "Insecure (non-HTTPS) registry", "Use an HTTPS registry endpoint.", { category: "security" }),
  WGL018: auditRule("WGL018", "report-only", "guidance", "Missing job timeout", "Add a `timeout:` to bound long-running jobs.", { category: "best-practice" }),
  WGL019: auditRule("WGL019", "report-only", "guidance", "Missing retry on deploy job", "Add a `retry:` strategy to deploy jobs.", { category: "best-practice" }),
  WGL020: auditRule("WGL020", "merge-worthy", "guidance", "Duplicate job names", "Rename so each job resolves to a unique name.", { category: "correctness" }),
  WGL021: auditRule("WGL021", "report-only", "guidance", "Unused global variable", "Remove the unused global `variables:` entry.", { category: "best-practice" }),
  WGL022: auditRule("WGL022", "report-only", "guidance", "Missing artifacts expiry", "Add `expire_in:` to artifacts to avoid disk bloat.", { category: "best-practice" }),
  WGL023: auditRule("WGL023", "report-only", "guidance", "Overly broad rules (when: always)", "Add real conditions to the job's `rules:`.", { category: "best-practice" }),
  WGL024: auditRule("WGL024", "report-only", "guidance", "Manual job without allow_failure", "Add `allow_failure: true` so a manual job doesn't block the pipeline.", { category: "best-practice" }),
  WGL025: auditRule("WGL025", "report-only", "guidance", "Cache without a key", "Add a `cache.key` to avoid cross-job cache collisions.", { category: "best-practice" }),
  WGL026: auditRule("WGL026", "merge-worthy", "guidance", "Privileged DinD service without TLS", "Set `DOCKER_TLS_CERTDIR` for privileged Docker-in-Docker services.", { category: "security" }),
  WGL027: auditRule("WGL027", "merge-worthy", "guidance", "Empty script", "Give the job a non-empty `script:`; it currently does nothing.", { category: "correctness" }),
  WGL028: auditRule("WGL028", "report-only", "guidance", "Redundant needs", "Drop `needs:` already implied by stage ordering.", { category: "best-practice" }),
  WGL029: auditRule("WGL029", "merge-worthy", "guidance", "include/component resolved by a moving ref", "Pin `include:project`/component to a tag or commit SHA, not a branch.", { authority: [SCORECARD_PINNED] }),
  WGL030: auditRule("WGL030", "merge-worthy", "guidance", "Insecure or mutable include:remote", "Use HTTPS and pin the remote include to an immutable ref.", { authority: [SCORECARD_PINNED] }),
  WGL031: auditRule("WGL031", "merge-worthy", "deterministic", "Container image not pinned to a digest", "Pin the image to an immutable `@sha256:` digest.", { authority: [SCORECARD_PINNED] }),
  WGL032: auditRule("WGL032", "merge-worthy", "guidance", "Possible include/component impersonation", "Verify the include source; it resembles a well-known project.", { authority: [SCORECARD_PINNED] }),
  WGL033: auditRule("WGL033", "merge-worthy", "guidance", "OIDC id_token without a scoped audience", "Set a specific `aud:` on the OIDC id_token.", { authority: [GH_OIDC] }),
  WGL034: auditRule("WGL034", "merge-worthy", "guidance", "OIDC id_token mintable from a merge-request pipeline", "Restrict OIDC token minting to protected pipelines.", { authority: [GH_OIDC, GH_PWN] }),
  WGL035: auditRule("WGL035", "merge-worthy", "guidance", "Untrusted CI variable interpolated into a script", "Pass untrusted variables via the environment and quote them; don't inline.", { authority: [GH_INJECTION] }),
  WGL036: auditRule("WGL036", "merge-worthy", "guidance", "Privileged service reachable from merge-request pipelines", "Block privileged/DinD services on merge-request pipelines.", { authority: [GH_PWN] }),
  WGL037: auditRule("WGL037", "merge-worthy", "guidance", "Security gate on an untrusted ref regex", "Don't gate security decisions on a regex over an untrusted ref variable.", { authority: [GH_PWN] }),
  WGL038: auditRule("WGL038", "merge-worthy", "guidance", "Secret reachable from a merge-request pipeline", "Scope secret-like variables to protected branches/pipelines.", { authority: [GH_SECRETS, GH_PWN] }),
  WGL039: auditRule("WGL039", "merge-worthy", "guidance", "Secret printed to job logs", "Stop echoing the secret-like variable; mask it.", { authority: [GH_SECRETS] }),
  WGL040: auditRule("WGL040", "merge-worthy", "guidance", "Hardcoded credential in a registry login", "Move the credential to a masked CI variable and rotate it.", { authority: [GH_SECRETS] }),
  WGL041: auditRule("WGL041", "merge-worthy", "guidance", "Tautological rules:if condition", "Fix the always-true `rules:if`; it may neutralize a gate.", { category: "correctness" }),
  WGL042: auditRule("WGL042", "report-only", "guidance", "Unreachable rules after an unconditional match", "Remove the dead `rules:` entries after the catch-all.", { category: "best-practice" }),
  WGL043: auditRule("WGL043", "merge-worthy", "guidance", "Match-anything regex gate in rules:if", "Tighten the regex; a match-anything gate is no gate.", { authority: [GH_PWN] }),
  WGL044: auditRule("WGL044", "merge-worthy", "guidance", "Public artifacts expose build output", "Mark sensitive artifacts non-public (`public: false`).", { category: "security" }),
  WGL045: auditRule("WGL045", "merge-worthy", "guidance", "Artifact path may capture a credential file", "Narrow the artifact path so it can't capture credential files.", { authority: [GH_SECRETS] }),
  WGL046: auditRule("WGL046", "merge-worthy", "guidance", "Cache populated in a merge-request pipeline", "Don't populate caches from merge-request pipelines (poisoning risk).", { authority: [GH_PWN] }),
  WGL047: auditRule("WGL047", "merge-worthy", "guidance", "Software piped to a shell without verification", "Verify a checksum/signature before executing fetched scripts.", { authority: [SCORECARD_PINNED] }),
  WGL048: auditRule("WGL048", "report-only", "guidance", "Pipeline without workflow:name", "Add a `workflow:name` for clearer pipeline naming.", { category: "best-practice" }),

  // Efficiency (#444) — waste, not a safety/correctness issue. Always
  // report-only: none of these warrant a merge on their own.
  WGL049: auditRule("WGL049", "report-only", "guidance", "Dependency install without a cache", "Add a `cache:` covering the dependency directory.", { category: "efficiency" }),
  WGL050: auditRule("WGL050", "report-only", "guidance", "Merge-request job missing interruptible", "Add `interruptible: true` so a superseded pipeline can be cancelled.", { category: "efficiency" }),
};

// Prior art credits live beside the rules in ./audit-lineage.ts (see core audit/prior-art.ts).
applyLineage(gitlabAuditCatalog, gitlabAuditLineage);
