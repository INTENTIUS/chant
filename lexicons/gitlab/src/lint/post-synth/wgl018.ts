/**
 * WGL018: Missing Timeout
 *
 * Warns about jobs without an explicit `timeout:` setting.
 * The default (1 hour) may be too long for most jobs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl018: PostSynthCheck = {
  id: "WGL018",
  description: "Missing timeout — jobs without explicit timeout may run too long",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props) continue;

      if (!props.timeout) {
        diagnostics.push({
          checkId: "WGL018",
          severity: "warning",
          message: `Job "${entityName}" has no explicit timeout — default is 1 hour which may be too long`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
