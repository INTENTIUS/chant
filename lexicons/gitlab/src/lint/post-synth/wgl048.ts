/**
 * WGL048: Pipeline Without a Name
 *
 * Flags a pipeline that defines a `workflow:` block but no `workflow:name:`.
 * A pipeline name shows up in the GitLab UI and audit output; naming pipelines
 * makes runs easier to identify and review. Only flags pipelines that already
 * customize `workflow:` (where a name is cheap to add and most useful).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "./yaml-helpers";

export const wgl048: PostSynthCheck = {
  id: "WGL048",
  description: "Pipeline defines workflow: but no workflow:name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const workflowSection = yaml.split("\n\n").find((s) => /^workflow:/.test(s));
      if (!workflowSection) continue;
      if (!/^\s+name:/m.test(workflowSection)) {
        diagnostics.push({
          checkId: "WGL048",
          severity: "info",
          message: `The pipeline defines a workflow: block but no workflow:name. Add a name so runs are identifiable in the GitLab UI and audit output.`,
          entity: "workflow",
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
