/**
 * WGL022: Missing Artifacts Expiry
 *
 * Warns about `artifacts:` without `expire_in:`, which causes disk bloat
 * on the GitLab instance. Default retention is "never expire" in some
 * GitLab configurations.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl022: PostSynthCheck = {
  id: "WGL022",
  description: "Missing artifacts expiry — artifacts without expire_in cause disk bloat",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props?.artifacts) continue;

      const artifacts = props.artifacts as Record<string, unknown>;
      // artifacts might be a Declarable with its own props
      const artProps = (artifacts.props as Record<string, unknown> | undefined) ?? artifacts;

      if (!artProps.expire_in && !artProps.expireIn) {
        diagnostics.push({
          checkId: "WGL022",
          severity: "warning",
          message: `Job "${entityName}" has artifacts without expire_in — set an expiry to avoid disk bloat`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
