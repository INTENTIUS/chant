/**
 * WGL027: Empty Script
 *
 * Detects jobs with `script: []` or scripts containing only empty strings.
 * GitLab rejects jobs with empty scripts at pipeline validation time.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl027: PostSynthCheck = {
  id: "WGL027",
  description: "Empty script — jobs with empty or blank script entries",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props) continue;

      const script = props.script;
      if (script === undefined || script === null) continue;

      let isEmpty = false;

      if (Array.isArray(script)) {
        if (script.length === 0) {
          isEmpty = true;
        } else if (script.every((s) => typeof s === "string" && s.trim() === "")) {
          isEmpty = true;
        }
      } else if (typeof script === "string" && script.trim() === "") {
        isEmpty = true;
      }

      if (isEmpty) {
        diagnostics.push({
          checkId: "WGL027",
          severity: "error",
          message: `Job "${entityName}" has an empty script — GitLab will reject this pipeline`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
