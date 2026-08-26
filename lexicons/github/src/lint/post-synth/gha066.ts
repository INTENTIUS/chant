/**
 * GHA066: Unbounded Artifact Retention
 *
 * Flags an `actions/upload-artifact` step with no `retention-days`, which
 * falls back to the repository's default (up to 90 days). Build logs, test
 * output, and intermediate artifacts rarely need to outlive the PR they came
 * from; an unset retention silently accumulates storage. Efficiency (#444),
 * not a correctness or security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobEntries, parseActionUses } from "./yaml-helpers";

export const gha066: PostSynthCheck = {
  id: "GHA066",
  description: "Uploaded artifact has no explicit retention-days",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      for (const [jobName, jobObj] of jobEntries(yaml)) {
        const steps = Array.isArray(jobObj.steps) ? (jobObj.steps as Array<Record<string, unknown>>) : [];
        for (const step of steps) {
          const uses = typeof step.uses === "string" ? step.uses : undefined;
          if (!uses || parseActionUses(uses)?.slug !== "actions/upload-artifact") continue;

          const withBlock = step.with as Record<string, unknown> | undefined;
          if (withBlock && withBlock["retention-days"] !== undefined) continue;

          const name = typeof withBlock?.name === "string" ? withBlock.name : undefined;
          diagnostics.push({
            checkId: "GHA066",
            severity: "info",
            message: `Job "${jobName}" uploads${name ? ` artifact "${name}"` : " an artifact"} with no \`retention-days\` — it falls back to the repository's default (up to 90 days). Set a \`retention-days\` sized to how long the artifact is actually needed.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
