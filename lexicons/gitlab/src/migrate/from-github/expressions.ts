/**
 * GitHub Actions expression substitution.
 *
 * Translates `${{ github.X }}`, `${{ runner.X }}`, `${{ secrets.X }}`,
 * `${{ env.X }}`, `${{ vars.X }}`, `${{ inputs.X }}`, `${{ matrix.X }}`,
 * and a small set of expression functions (`always()`, `failure()`, etc.)
 * to their GitLab CI predefined-variable equivalents.
 *
 * Source: the upstream `github-actions-to-gitlab-ci` skill's
 * `references/syntax-mapping.md` "github.* context expressions" tables.
 */

import type { ProvenanceRecord } from "./provenance";

/**
 * Direct 1:1 mappings from GitHub context identifiers to GitLab predefined
 * variables. Keys are the dotted identifier *without* the `${{ }}` wrapper.
 */
const GITHUB_CONTEXT_MAP: Record<string, string> = {
  "github.sha": "$CI_COMMIT_SHA",
  "github.ref": "$CI_COMMIT_REF_NAME",
  "github.ref_name": "$CI_COMMIT_REF_NAME",
  "github.repository": "$CI_PROJECT_PATH",
  "github.repository_owner": "$CI_PROJECT_NAMESPACE",
  "github.actor": "$GITLAB_USER_LOGIN",
  "github.triggering_actor": "$GITLAB_USER_LOGIN",
  "github.event_name": "$CI_PIPELINE_SOURCE",
  "github.workflow": "$CI_PIPELINE_NAME",
  "github.run_id": "$CI_PIPELINE_ID",
  "github.run_number": "$CI_PIPELINE_IID",
  "github.job": "$CI_JOB_NAME",
  "github.head_ref": "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
  "github.base_ref": "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "github.workspace": "$CI_PROJECT_DIR",
  "github.server_url": "$CI_SERVER_URL",
  "runner.workspace": "$CI_PROJECT_DIR",
  "job.status": "$CI_JOB_STATUS",
  "strategy.job-index": "$CI_NODE_INDEX",
  "strategy.job-total": "$CI_NODE_TOTAL",
};

/**
 * GitHub expressions with no GitLab equivalent. When detected, the
 * substitution leaves a placeholder and registers a needs-review record.
 */
const NO_EQUIVALENT = new Set<string>([
  "github.run_attempt",
  "runner.os",
  "runner.arch",
  "runner.temp",
  "job.container.id",
]);

/**
 * Map a GitHub `if:` boolean function to a GitLab `when:` value or rule.
 *
 * Returned tuple is `[gitlabExpression, isWhenClause]` — when `isWhenClause`
 * is true, the caller should emit `when: <expr>` rather than `if: <expr>`.
 */
export function translateIfFunction(
  expr: string,
): { expression: string; whenClause?: string; needsReview?: boolean } {
  const trimmed = expr.trim();
  if (trimmed === "always()") return { expression: "true", whenClause: "always" };
  if (trimmed === "success()") return { expression: "true", whenClause: "on_success" };
  if (trimmed === "failure()") return { expression: "true", whenClause: "on_failure" };
  if (trimmed === "cancelled()" || trimmed === "canceled()") {
    return { expression: "true", needsReview: true };
  }
  return { expression: trimmed };
}

/**
 * Substitute all `${{ ... }}` template expressions in a string with their
 * GitLab equivalents. Returns the substituted string plus any provenance
 * records describing which substitutions happened (or which need review).
 */
export function substituteExpressions(
  input: string,
  ctx: { gitlabPath: string; sourceKey?: string; sourceFile?: string },
): { output: string; provenance: ProvenanceRecord[] } {
  const records: ProvenanceRecord[] = [];
  // GitHub expressions are wrapped in ${{ ... }}.
  const output = input.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const trimmed = expr.trim();

    // Direct context lookup
    if (Object.prototype.hasOwnProperty.call(GITHUB_CONTEXT_MAP, trimmed)) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-EXPR-CONTEXT",
        note: `${trimmed} → ${GITHUB_CONTEXT_MAP[trimmed]}`,
      });
      return GITHUB_CONTEXT_MAP[trimmed];
    }

    // env.NAME / vars.NAME / secrets.NAME → $NAME
    const userVarMatch = /^(env|vars|secrets|inputs|matrix)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    if (userVarMatch) {
      const [, , name] = userVarMatch;
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-EXPR-USERVAR",
        note: `${trimmed} → $${name}`,
      });
      return `$${name}`;
    }

    // steps.<id>.outputs.<name> → $name with needs-review note (requires dotenv)
    const stepsOutputMatch = /^steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    if (stepsOutputMatch) {
      const [, , name] = stepsOutputMatch;
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-NEEDS-OUTPUTS-001",
        note: `${trimmed} requires artifacts:reports:dotenv pattern in GitLab; emitting $${name} placeholder`,
      });
      return `$${name}`;
    }

    // needs.<job>.outputs.<name> → $name with needs-review note
    const needsOutputMatch = /^needs\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    if (needsOutputMatch) {
      const [, , name] = needsOutputMatch;
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-NEEDS-OUTPUTS-001",
        note: `${trimmed} requires artifacts:reports:dotenv pattern in GitLab; emitting $${name} placeholder`,
      });
      return `$${name}`;
    }

    // Boolean expression functions: always(), success(), failure(), cancelled()
    const fnResult = translateIfFunction(trimmed);
    if (fnResult.whenClause) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-EXPR-FUNCTION",
        note: `${trimmed} → when: ${fnResult.whenClause}`,
      });
      return fnResult.expression;
    }

    // No-equivalent context expressions
    if (NO_EQUIVALENT.has(trimmed)) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-EXPR-NO-EQUIV",
        note: `${trimmed} has no GitLab predefined variable equivalent`,
      });
      return `# TODO: ${trimmed} has no GitLab equivalent`;
    }

    // Unknown expression — leave the original and flag
    records.push({
      gitlabPath: ctx.gitlabPath,
      sourceKey: ctx.sourceKey,
      sourceFile: ctx.sourceFile,
      category: "needs-review",
      rule: "MIG-EXPR-UNKNOWN",
      note: `Could not translate expression: ${match}`,
    });
    return match;
  });

  return { output, provenance: records };
}

/**
 * Substitute GitHub identifiers (e.g. `github.ref`) appearing anywhere
 * in a string with their GitLab predefined-variable equivalents.
 * Used for if-conditions, concurrency.group values, and other places
 * where identifiers appear without `${{ }}` wrapping.
 */
export function substituteIdentifiers(
  input: string,
  ctx: { gitlabPath: string; sourceKey?: string; sourceFile?: string },
): { output: string; provenance: ProvenanceRecord[] } {
  const records: ProvenanceRecord[] = [];
  // Match dotted identifiers like `github.ref_name`, `runner.os`,
  // `steps.foo.outputs.bar`, `env.NAME`, etc. — but not when they are
  // already prefixed by `$` (already substituted).
  const output = input.replace(/(?<![\w$])([a-z]+(?:\.[A-Za-z_][A-Za-z0-9_-]*)+)/g, (match: string) => {
    if (Object.prototype.hasOwnProperty.call(GITHUB_CONTEXT_MAP, match)) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-EXPR-CONTEXT",
        note: `${match} → ${GITHUB_CONTEXT_MAP[match]}`,
      });
      return GITHUB_CONTEXT_MAP[match];
    }
    const userVar = /^(env|vars|secrets|inputs|matrix)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(match);
    if (userVar) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-EXPR-USERVAR",
        note: `${match} → $${userVar[2]}`,
      });
      return `$${userVar[2]}`;
    }
    const stepsOutput = /^steps\.[A-Za-z_][A-Za-z0-9_-]*\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(match);
    if (stepsOutput) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-NEEDS-OUTPUTS-001",
        note: `${match} requires artifacts:reports:dotenv pattern; emitting $${stepsOutput[1]} placeholder`,
      });
      return `$${stepsOutput[1]}`;
    }
    const needsOutput = /^needs\.[A-Za-z_][A-Za-z0-9_-]*\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(match);
    if (needsOutput) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-NEEDS-OUTPUTS-001",
        note: `${match} requires artifacts:reports:dotenv pattern; emitting $${needsOutput[1]} placeholder`,
      });
      return `$${needsOutput[1]}`;
    }
    if (NO_EQUIVALENT.has(match)) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "needs-review",
        rule: "MIG-EXPR-NO-EQUIV",
        note: `${match} has no GitLab predefined variable equivalent`,
      });
      return match;
    }
    return match;
  });
  return { output, provenance: records };
}

/**
 * Translate a GitHub `if:` condition expression (without `${{ }}` wrapping)
 * into a GitLab `rules:if:` expression. Returns substituted expression and
 * any whenClause hint extracted from boolean function calls.
 */
export function translateIfCondition(
  rawIf: string,
  ctx: { gitlabPath: string; sourceKey?: string; sourceFile?: string },
): { ifExpression: string; whenClause?: string; provenance: ProvenanceRecord[] } {
  const records: ProvenanceRecord[] = [];
  let whenClause: string | undefined;

  // If the whole expression is a single boolean function, translate to when:
  const fnAlone = /^\s*([a-z]+\(\))\s*$/i.exec(rawIf);
  if (fnAlone) {
    const fnResult = translateIfFunction(fnAlone[1]);
    if (fnResult.whenClause) {
      records.push({
        gitlabPath: ctx.gitlabPath,
        sourceKey: ctx.sourceKey,
        sourceFile: ctx.sourceFile,
        category: "rewrite",
        rule: "MIG-IF-WHEN",
        note: `if: ${fnAlone[1]} → when: ${fnResult.whenClause}`,
      });
      whenClause = fnResult.whenClause;
      return { ifExpression: "", whenClause, provenance: records };
    }
  }

  // Strip any `${{ }}` wrappers first
  const unwrapped = rawIf.replace(/\$\{\{\s*/g, "").replace(/\s*\}\}/g, "");
  // Then substitute identifiers inline
  const subbed = substituteIdentifiers(unwrapped, ctx);
  records.push(...subbed.provenance);

  return { ifExpression: subbed.output, whenClause, provenance: records };
}
