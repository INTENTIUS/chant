/**
 * The docker lexicon's `chant audit` catalog — metadata for the DKRD*
 * Dockerfile/Compose post-synth rules. Contributed via `dockerPlugin.auditCatalog()` (#687).
 */
import { auditRule, SCORECARD_PINNED, type RuleMeta, type Authority } from "@intentius/chant/audit/catalog";

const DOCKER_SEC: Authority = { name: "Docker — Security best practices", url: "https://docs.docker.com/develop/security-best-practices/" };

export const dockerAuditCatalog: Record<string, RuleMeta> = {
  DKRD001: auditRule("DKRD001", "merge-worthy", "guidance", "Service uses :latest or untagged image", "Pin the image to an explicit version tag (ideally a digest).", { authority: [SCORECARD_PINNED] }),
  DKRD002: auditRule("DKRD002", "report-only", "guidance", "Named volume declared but unused", "Remove the unused volume or mount it in a service.", { category: "best-practice" }),
  DKRD003: auditRule("DKRD003", "merge-worthy", "guidance", "Service exposes SSH (port 22)", "Don't expose SSH from a container; use exec/ephemeral access instead.", { authority: [DOCKER_SEC] }),
  DKRD010: auditRule("DKRD010", "report-only", "guidance", "apt-get install without --no-install-recommends", "Add --no-install-recommends to keep images small.", { category: "best-practice" }),
  DKRD011: auditRule("DKRD011", "report-only", "guidance", "ADD used where COPY would do", "Prefer COPY unless fetching a URL or extracting an archive.", { category: "best-practice" }),
  DKRD012: auditRule("DKRD012", "merge-worthy", "guidance", "No USER instruction — container runs as root", "Add a non-root USER instruction.", { authority: [DOCKER_SEC] }),
};
