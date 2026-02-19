/**
 * WGL011: Unreachable job
 *
 * Detects jobs where all `rules:` entries evaluate to `when: never`,
 * making the job unreachable. This usually indicates a configuration error.
 *
 * Note: This is a simple static check — it only catches the obvious case
 * where every rule has `when: "never"` literally set. Complex conditions
 * with `if:` expressions are not evaluated.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl011: PostSynthCheck = {
  id: "WGL011",
  description: "Job has rules that always evaluate to never (unreachable)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props?.rules || !Array.isArray(props.rules)) continue;

      const rules = props.rules as Array<Record<string, unknown>>;
      if (rules.length === 0) continue;

      // Check if ALL rules have when: "never"
      const allNever = rules.every((rule) => {
        // If the rule is a declarable (e.g. new Rule({...})), check its props
        const ruleProps = (rule as Record<string, unknown>).props as Record<string, unknown> | undefined;
        const when = ruleProps?.when ?? (rule as Record<string, unknown>).when;
        return when === "never";
      });

      if (allNever) {
        diagnostics.push({
          checkId: "WGL011",
          severity: "warning",
          message: `Job "${entityName}" has rules that all evaluate to "never" — this job will never run.`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
