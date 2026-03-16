/**
 * GHA027: Missing `if: always()` on Cleanup Steps
 *
 * Flags steps whose name contains "cleanup", "teardown", or "clean up"
 * (case-insensitive) that lack an `if:` condition. Cleanup steps should
 * typically run with `if: always()` so they execute even when prior steps fail.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

const CLEANUP_PATTERN = /cleanup|teardown|clean\s+up/i;

export const gha027: PostSynthCheck = {
  id: "GHA027",
  description: "Missing `if: always()` on cleanup steps",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      // Scan raw YAML for step blocks with cleanup-like names
      const stepPattern = /-\s+name:\s+(.+)/g;
      let match: RegExpExecArray | null;

      while ((match = stepPattern.exec(yaml)) !== null) {
        const stepName = match[1].trim().replace(/^['"]|['"]$/g, "");
        if (!CLEANUP_PATTERN.test(stepName)) continue;

        // Get the block after this step name line
        const afterName = yaml.slice(match.index + match[0].length);
        // Capture lines until the next step entry or job
        const blockEnd = afterName.search(/\n\s{6}-\s|\n\s{2}[a-z]/);
        const block = blockEnd === -1 ? afterName : afterName.slice(0, blockEnd);

        if (!/^\s+if:/m.test(block)) {
          // Find which job this step belongs to
          const beforeStep = yaml.slice(0, match.index);
          const jobMatch = [...beforeStep.matchAll(/^\s{2}([a-z][a-z0-9-]*):/gm)];
          const jobName = jobMatch.length > 0 ? jobMatch[jobMatch.length - 1][1] : "unknown";

          diagnostics.push({
            checkId: "GHA027",
            severity: "info",
            message: `Step "${stepName}" in job "${jobName}" looks like a cleanup step but has no \`if:\` condition. Add \`if: always()\` so it runs even when prior steps fail.`,
            entity: `${jobName}.${stepName}`,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
