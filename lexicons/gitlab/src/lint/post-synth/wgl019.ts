/**
 * WGL019: Missing Retry on Deploy Jobs
 *
 * Deploy-stage jobs should have a `retry:` strategy to handle transient
 * infrastructure failures. This is informational, not a hard requirement.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

const DEPLOY_STAGES = new Set(["deploy", "deployment", "release", "production", "staging"]);

export const wgl019: PostSynthCheck = {
  id: "WGL019",
  description: "Missing retry — deploy jobs without retry strategy",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props) continue;

      const stage = props.stage as string | undefined;
      if (!stage || !DEPLOY_STAGES.has(stage.toLowerCase())) continue;

      if (!props.retry) {
        diagnostics.push({
          checkId: "WGL019",
          severity: "info",
          message: `Deploy job "${entityName}" (stage: ${stage}) has no retry strategy — consider adding retry for transient failures`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
