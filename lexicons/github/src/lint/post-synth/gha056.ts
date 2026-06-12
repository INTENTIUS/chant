/**
 * GHA056: Workflow Without a `name:`
 *
 * Flags an emitted workflow with no top-level `name:`. Without one, GitHub falls
 * back to the file path in the Actions UI and audit logs, making runs harder to
 * identify and review. A clear name improves observability and audit output.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractWorkflowName } from "./yaml-helpers";

export const gha056: PostSynthCheck = {
  id: "GHA056",
  description: "Workflow without a name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      // Only inspect things that look like workflows (have a jobs: block).
      if (!/^jobs:\s*$/m.test(yaml)) continue;
      const name = extractWorkflowName(yaml);
      if (!name) {
        diagnostics.push({
          checkId: "GHA056",
          severity: "info",
          message: `Workflow "${lexicon}" has no top-level name: — add one so runs are identifiable in the Actions UI and audit logs.`,
          entity: "workflow",
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
