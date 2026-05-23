/**
 * Tier 3 marketplace action mappings — 5 niche actions. Several map to
 * native GitLab keywords (rules:changes, retry:) rather than scripts.
 */

import type { ActionMapping, ActionMappedResult, ActionMapCtx } from "./registry";
import { getDefaultRegistry } from "./registry";

const prov = (
  ctx: ActionMapCtx,
  actionName: string,
  note: string,
  category: "literal" | "needs-review" | "skipped" | "action-map" = "action-map",
) => ({
  gitlabPath: `jobs.${ctx.logicalId}.script`,
  gitlabLogicalId: ctx.logicalId,
  sourceKey: `jobs.${ctx.jobName}.steps[${ctx.stepIndex}].uses`,
  sourceFile: ctx.sourceFile,
  category,
  rule: `ACT-${actionName.replace(/[\/-]/g, "-")}`,
  note,
  actionRef: actionName,
  mappingTier: 3 as const,
});

const getWith = (s: Record<string, unknown>): Record<string, unknown> =>
  (s.with as Record<string, unknown>) ?? {};

const tjActionsChangedFiles: ActionMapping = {
  actionName: "tj-actions/changed-files",
  tier: 3,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const files = (w.files as string) ?? "";
    return {
      scriptLines: [
        `git diff --name-only $CI_COMMIT_BEFORE_SHA $CI_COMMIT_SHA${files ? ` | grep -E '${files.replace(/\n/g, "|")}' || true` : ""}`,
      ],
      provenance: [prov(ctx, "tj-actions/changed-files", "tj-actions/changed-files → git diff inline; for path-based job gating prefer rules:changes:")],
    };
  },
};

// dorny/paths-filter: native rules:changes:
const dornyPathsFilter: ActionMapping = {
  actionName: "dorny/paths-filter",
  tier: 3,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: [
        "# dorny/paths-filter has no script equivalent in GitLab.",
        "# Use rules:changes: on each job to gate on file path changes.",
        "# Example: rules: [{ changes: ['src/backend/**'] }]",
      ],
      provenance: [prov(
        ctx,
        "dorny/paths-filter",
        "dorny/paths-filter → native rules:changes:; emit rule on each gated job",
        "needs-review",
      )],
    };
  },
};

// nick-invision/retry / nick-fields/retry: native retry:
const nickFieldsRetry: ActionMapping = {
  actionName: "nick-fields/retry",
  tier: 3,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const command = (w.command as string) ?? "";
    return {
      scriptLines: command ? [command] : [],
      provenance: [prov(
        ctx,
        "nick-fields/retry",
        "nick-fields/retry → native retry: { max, when } at job level; configure manually",
        "needs-review",
      )],
    };
  },
};

const preCommitAction: ActionMapping = {
  actionName: "pre-commit/action",
  tier: 3,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: ["pip install pre-commit", "pre-commit run --all-files"],
      provenance: [prov(ctx, "pre-commit/action", "pre-commit/action → pip install pre-commit + pre-commit run")],
    };
  },
};

const slackapiGithubAction: ActionMapping = {
  actionName: "slackapi/slack-github-action",
  tier: 3,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const payload = (w.payload as string) ?? '{"text":"Build completed"}';
    return {
      scriptLines: [
        `curl -X POST -H 'Content-type: application/json' --data '${payload.replace(/'/g, "'\\''")}' $SLACK_WEBHOOK_URL`,
      ],
      provenance: [prov(ctx, "slackapi/slack-github-action", "slack-github-action → curl to $SLACK_WEBHOOK_URL")],
    };
  },
};

const TIER_3_MAPPINGS: ActionMapping[] = [
  tjActionsChangedFiles,
  dornyPathsFilter,
  nickFieldsRetry,
  preCommitAction,
  slackapiGithubAction,
];

export function registerTier3(registry = getDefaultRegistry()): void {
  for (const m of TIER_3_MAPPINGS) {
    registry.register(m);
  }
}

export { TIER_3_MAPPINGS };
