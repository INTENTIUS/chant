/**
 * The docker lexicon's `chant audit` catalog — metadata for the DKRD*
 * Dockerfile/Compose post-synth rules. Contributed via `dockerPlugin.auditCatalog()` (#687).
 */
import { auditRule, SCORECARD_PINNED, type RuleMeta, type Authority, applyLineage } from "@intentius/chant/audit/catalog";
import { dockerAuditLineage } from "./audit-lineage";

const DOCKER_SEC: Authority = { name: "Docker — Security best practices", url: "https://docs.docker.com/develop/security-best-practices/" };

export const dockerAuditCatalog: Record<string, RuleMeta> = {
  DKRD001: auditRule("DKRD001", "merge-worthy", "guidance", "Service uses :latest or untagged image", "Pin the image to an explicit version tag (ideally a digest).", { authority: [SCORECARD_PINNED] }),
  DKRD002: auditRule("DKRD002", "report-only", "guidance", "Named volume declared but unused", "Remove the unused volume or mount it in a service.", { category: "best-practice" }),
  DKRD003: auditRule("DKRD003", "merge-worthy", "guidance", "Service exposes SSH (port 22)", "Don't expose SSH from a container; use exec/ephemeral access instead.", { authority: [DOCKER_SEC] }),
  DKRD010: auditRule("DKRD010", "report-only", "guidance", "apt-get install without --no-install-recommends", "Add --no-install-recommends to keep images small.", { category: "best-practice" }),
  DKRD011: auditRule("DKRD011", "report-only", "guidance", "ADD used where COPY would do", "Prefer COPY unless fetching a URL or extracting an archive.", { category: "best-practice" }),
  DKRD012: auditRule("DKRD012", "merge-worthy", "guidance", "Final stage has no USER, or ends on USER root — container runs as root", "Add a non-root USER instruction to the final stage, after the root setup steps.", { authority: [DOCKER_SEC] }),
  DKRD013: auditRule("DKRD013", "report-only", "guidance", "Whole build context copied before a dependency install", "Copy the dependency manifests, run the install, then copy the rest of the source.", { category: "efficiency" }),
  DKRD014: auditRule("DKRD014", "report-only", "guidance", "Root-only RUN after a non-root USER", "Run package installs and user/ownership changes before switching USER.", { category: "correctness" }),
  DKRD015: auditRule("DKRD015", "report-only", "guidance", "More than one CMD or ENTRYPOINT in a stage", "Keep one CMD and one ENTRYPOINT per stage; only the last takes effect.", { category: "correctness" }),
  DKRD016: auditRule("DKRD016", "report-only", "guidance", "COPY --from names no earlier stage", "Name a stage defined earlier in the Dockerfile, or a tagged image.", { category: "correctness" }),
  DKRD017: auditRule("DKRD017", "report-only", "guidance", "ARG before FROM is never used", "Use the ARG in a FROM line, declare it again in the stage that needs it, or remove it.", { category: "best-practice" }),
  DKRD018: auditRule("DKRD018", "report-only", "guidance", "Relative WORKDIR", "Use an absolute WORKDIR path.", { category: "best-practice" }),
  DKRD019: auditRule("DKRD019", "report-only", "guidance", "ADD of a remote URL without --checksum", "Add --checksum=sha256:<digest> to ADD of an http(s) URL.", { category: "security" }),
  DKRD020: auditRule("DKRD020", "report-only", "guidance", "apt-get update in its own RUN", "Run apt-get update and apt-get install in the same RUN.", { category: "correctness" }),
};

// Prior art credits live beside the rules in ./audit-lineage.ts (see core audit/prior-art.ts).
applyLineage(dockerAuditCatalog, dockerAuditLineage);
