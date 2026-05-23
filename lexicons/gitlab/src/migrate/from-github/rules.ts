/**
 * Static LintRule metadata for SARIF enrichment.
 *
 * Each rule fired by the transformer (provenance.rule field) gets a
 * corresponding entry here so SARIF output carries description + helpUri.
 *
 * These rules don't actually run a `check()` — the work has already been
 * done by the transformer. They're metadata-only.
 */

import type { LintRule } from "@intentius/chant/lint/rule";

const noopCheck = () => [];

function rule(id: string, severity: "error" | "warning" | "info", description: string): LintRule {
  return {
    id,
    severity,
    category: "correctness",
    description,
    helpUri: `https://intentius.io/chant/lexicons/gitlab/migration#${id.toLowerCase()}`,
    check: noopCheck,
  };
}

export const MIGRATION_RULES: LintRule[] = [
  // Trigger translations
  rule("MIG-ON-PUSH", "info", "GitHub on: push → workflow.rules push"),
  rule("MIG-ON-PR", "info", "GitHub on: pull_request → workflow.rules merge_request_event"),
  rule("MIG-ON-SCHEDULE", "warning", "GitHub on: schedule requires GitLab CI/CD > Schedules UI configuration"),
  rule("MIG-ON-DISPATCH", "warning", "GitHub on: workflow_dispatch inputs require spec:inputs (GitLab 17+) with defaults"),
  rule("MIG-ON-NON-GIT", "warning", "GitHub event has no GitLab equivalent — GitLab pipelines run on git events only"),
  rule("MIG-ON-UNKNOWN", "warning", "Unknown GitHub trigger event"),

  // Job-level translations
  rule("MIG-WORKFLOW-NAME", "info", "name → workflow.name"),
  rule("MIG-WORKFLOW-ENV", "info", "Workflow env → top-level variables"),
  rule("MIG-JOB-ENV", "info", "Job env → variables"),
  rule("MIG-TIMEOUT", "info", "timeout-minutes → timeout"),
  rule("MIG-ALLOW-FAILURE", "info", "continue-on-error → allow_failure"),
  rule("MIG-NEEDS", "info", "needs: passthrough"),
  rule("MIG-CONCURRENCY", "info", "concurrency.group/cancel-in-progress → resource_group/interruptible"),
  rule("MIG-SERVICES", "info", "services: passthrough"),
  rule("MIG-CONTAINER", "info", "container.image → image"),
  rule("MIG-MATRIX", "info", "strategy.matrix → parallel.matrix"),

  // runs-on
  rule("MIG-RUNS-ON-001", "info", "runs-on: linux runner → Docker image"),
  rule("MIG-RUNS-ON-NON-LINUX", "warning", "Non-Linux runs-on requires self-hosted runner with tag"),
  rule("MIG-RUNS-ON-TAG", "info", "Custom runs-on label → tags:"),

  // Expressions
  rule("MIG-EXPR-CONTEXT", "info", "github.*/runner.*/job.* → predefined $CI_* variable"),
  rule("MIG-EXPR-USERVAR", "info", "env.*/vars.*/secrets.*/inputs.*/matrix.* → $NAME"),
  rule("MIG-EXPR-FUNCTION", "info", "Boolean function → when: clause"),
  rule("MIG-EXPR-NO-EQUIV", "warning", "GitHub expression has no GitLab equivalent"),
  rule("MIG-EXPR-UNKNOWN", "warning", "Could not translate expression"),

  // Rule conversions
  rule("MIG-IF-WHEN", "info", "if: boolean_function() → when:"),

  // Permissions and outputs
  rule("MIG-PERMISSIONS-001", "warning", "GitHub permissions: has no per-job equivalent — configure CI/CD token at project level"),
  rule("MIG-JOB-OUTPUTS", "warning", "GitHub job outputs require artifacts:reports:dotenv pattern in GitLab"),
  rule("MIG-NEEDS-OUTPUTS-001", "warning", "steps/needs outputs require artifacts:reports:dotenv pattern"),

  // Matrix
  rule("MIG-MATRIX-INCLUDE-001", "warning", "matrix.include/exclude has no direct GitLab equivalent"),
  rule("MIG-FAIL-FAST", "warning", "strategy.fail-fast has no GitLab equivalent (default behaviour is non-fail-fast)"),

  // Reusable workflow + step env
  rule("MIG-REUSABLE-WORKFLOW", "warning", "GitHub reusable workflow → GitLab include: with variable substitution (no typed inputs)"),
  rule("MIG-STEP-ENV-CONFLICT", "warning", "Step-level env var conflict; using last value"),

  // Stage inference
  rule("MIG-STAGE-TOPO", "info", "Stage assigned by needs: depth"),
  rule("MIG-STAGE-HEURISTIC", "info", "Stage assigned by job name heuristic"),
  rule("MIG-NEEDS-CYCLE-001", "warning", "needs: cycle detected; each cycle member in its own stage"),

  // Action mapping fallback
  rule("MIG-ACTION-UNKNOWN", "warning", "Marketplace action has no registered mapping"),
];
