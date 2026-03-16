/**
 * WGL024: Manual Without allow_failure
 *
 * Warns about jobs with `when: manual` that don't set `allow_failure: true`.
 * Without it, the manual job blocks the pipeline from progressing past
 * its stage until someone manually triggers it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl024: PostSynthCheck = {
  id: "WGL024",
  description: "Manual without allow_failure — manual jobs block pipeline without allow_failure: true",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props) continue;

      // Check top-level when: manual
      const isManual = props.when === "manual";
      if (!isManual) continue;

      // Check allow_failure
      const allowFailure = props.allow_failure ?? props.allowFailure;
      if (allowFailure !== true) {
        diagnostics.push({
          checkId: "WGL024",
          severity: "warning",
          message: `Job "${entityName}" has when: manual but no allow_failure: true — this will block the pipeline`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
