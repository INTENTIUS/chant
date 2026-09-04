/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const gitlabAuditLineage: Record<string, Lineage[]> = {
  WGL010: [
    { tool: "gitlab-docs", rule: "stage: supported values are the default stages or stages listed in `stages`", url: "https://docs.gitlab.com/ci/yaml/#stage", relation: "equivalent" },
  ],
  WGL012: [
    { tool: "gitlab-docs", rule: "Deprecated keywords (only/except, globally-defined image/services/cache/before_script/after_script)", url: "https://docs.gitlab.com/ci/yaml/deprecated_keywords/#only--except", relation: "equivalent" },
  ],
  WGL013: [
    { tool: "gitlab-docs", rule: "Error: 'job' does not exist in the pipeline (needs)", url: "https://docs.gitlab.com/ci/yaml/needs/#error-job-does-not-exist-in-the-pipeline", relation: "equivalent" },
  ],
  WGL014: [
    { tool: "gitlab-docs", rule: "extends: supported values are the name(s) of another job in the pipeline", url: "https://docs.gitlab.com/ci/yaml/#extends", relation: "equivalent" },
  ],
  WGL016: [
    { tool: "gitlab-docs", rule: "CI/CD variable security (secrets belong in masked/protected variables, not in .gitlab-ci.yml)", url: "https://docs.gitlab.com/ci/variables/#cicd-variable-security", relation: "overlaps" },
  ],
  WGL023: [
    { tool: "gitlab-docs", rule: "Pipeline warning: Job may allow multiple pipelines to run for a single action (final `when` rule without conditions)", url: "https://docs.gitlab.com/ci/debugging/#job-may-allow-multiple-pipelines-to-run-for-a-single-action-warning", relation: "overlaps" },
  ],
  WGL024: [
    { tool: "gitlab-docs", rule: "allow_failure default: true for manual jobs, false for rules:when: manual", url: "https://docs.gitlab.com/ci/yaml/#allow_failure", relation: "overlaps" },
  ],
  WGL025: [
    { tool: "gitlab-docs", rule: "cache:key: all jobs with `cache` but no `cache:key` share the `default` cache", url: "https://docs.gitlab.com/ci/yaml/#cachekey", relation: "overlaps" },
  ],
  WGL026: [
    { tool: "gitlab-docs", rule: "Docker-in-Docker with TLS enabled (recommended); DOCKER_TLS_CERTDIR", url: "https://docs.gitlab.com/ci/docker/docker_in_docker/#docker-in-docker-with-tls-enabled-in-the-docker-executor-recommended", relation: "overlaps" },
  ],
  WGL029: [
    { tool: "gitlab-docs", rule: "include:project ref guidance: use a specific SHA hash, protected branch/tag rules", url: "https://docs.gitlab.com/ci/yaml/#includeproject", relation: "overlaps" },
    { tool: "gitlab-docs", rule: "CI/CD component security best practices: use pinned versions (commit SHA preferred), avoid `latest`", url: "https://docs.gitlab.com/ci/components/#for-component-users", relation: "overlaps" },
  ],
  WGL030: [
    { tool: "gitlab-docs", rule: "include:remote: treat as a third-party dependency; verify integrity with include:integrity", url: "https://docs.gitlab.com/ci/yaml/#includeremote", relation: "overlaps" },
  ],
  WGL031: [
    { tool: "gitlab-docs", rule: "Use checksum to keep your image secure (image@sha256:digest)", url: "https://docs.gitlab.com/ci/docker/using_docker_images/#use-checksum-to-keep-your-image-secure", relation: "overlaps" },
  ],
  WGL033: [
    { tool: "gitlab-docs", rule: "id_tokens: the required `aud` sub-keyword configures the aud claim", url: "https://docs.gitlab.com/ci/yaml/#id_tokens", relation: "overlaps" },
  ],
  WGL035: [
    { tool: "poutine", rule: "injection", url: "https://boostsecurityio.github.io/poutine/rules/injection/", relation: "overlaps" },
  ],
  WGL038: [
    { tool: "gitlab-docs", rule: "Protect a CI/CD variable (available only to protected branches/tags)", url: "https://docs.gitlab.com/ci/variables/#protect-a-cicd-variable", relation: "overlaps" },
    { tool: "gitlab-docs", rule: "Merge request pipelines from forked projects can steal secrets in the parent project", url: "https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/#use-with-forked-projects", relation: "overlaps" },
  ],
  WGL039: [
    { tool: "gitlab-docs", rule: "CI/CD variable security: accidental-leak-job example (echo of $PASSWORD); mask sensitive variables", url: "https://docs.gitlab.com/ci/variables/#mask-a-cicd-variable", relation: "overlaps" },
  ],
  WGL044: [
    { tool: "gitlab-docs", rule: "artifacts:public (default true: downloadable by anonymous users in public pipelines)", url: "https://docs.gitlab.com/ci/yaml/#artifactspublic", relation: "overlaps" },
  ],
  WGL046: [
    { tool: "gitlab-docs", rule: "Cache key names: protected and non-protected branches do not share the cache by default", url: "https://docs.gitlab.com/ci/caching/#cache-key-names", relation: "overlaps" },
  ],
  WGL047: [
    { tool: "poutine", rule: "unverified_script_exec", url: "https://boostsecurityio.github.io/poutine/rules/unverified_script_exec/", relation: "equivalent" },
  ],
  WGL048: [
    { tool: "gitlab-docs", rule: "Use pipeline names (workflow:name)", url: "https://docs.gitlab.com/ci/debugging/#use-pipeline-names", relation: "overlaps" },
  ],
};
