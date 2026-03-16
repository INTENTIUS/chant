/**
 * WGL023: Overly Broad Rules
 *
 * Flags jobs with a single rule that has only `when: always` and no
 * conditions (no `if:`, `changes:`, etc.). This effectively disables
 * all pipeline filtering for the job, which is usually unintended.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl023: PostSynthCheck = {
  id: "WGL023",
  description: "Overly broad rules — job with only when: always rule (no conditions)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props?.rules || !Array.isArray(props.rules)) continue;

      const rules = props.rules as Array<Record<string, unknown>>;
      if (rules.length !== 1) continue;

      const rule = rules[0];
      const ruleProps = (rule.props as Record<string, unknown> | undefined) ?? rule;

      const when = ruleProps.when;
      const hasIf = !!ruleProps.if;
      const hasChanges = !!ruleProps.changes;
      const hasExists = !!ruleProps.exists;

      if (when === "always" && !hasIf && !hasChanges && !hasExists) {
        diagnostics.push({
          checkId: "WGL023",
          severity: "info",
          message: `Job "${entityName}" has a single rule with only "when: always" — this disables all pipeline filtering. Consider adding conditions or removing rules entirely.`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
