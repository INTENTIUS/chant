/**
 * GHA033: Blanket `write-all` Token Permissions
 *
 * Flags a `permissions: write-all` grant at the workflow or job level. It hands
 * the `GITHUB_TOKEN` every write scope regardless of what the job uses, so any
 * compromised or injected step becomes a write-capable actor across the repo.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractWorkflowPermissions, extractJobPermissions, writeSurface } from "./yaml-helpers";

export const gha033: PostSynthCheck = {
  id: "GHA033",
  description: "Blanket write-all token permissions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const wf = extractWorkflowPermissions(yaml);
      if (wf && writeSurface(wf).writeAll) {
        diagnostics.push({
          checkId: "GHA033",
          severity: "warning",
          message: `Workflow declares permissions: write-all — replace it with the specific scopes the jobs actually need (least privilege).`,
          lexicon: "github",
        });
      }

      for (const [job, perms] of extractJobPermissions(yaml)) {
        if (writeSurface(perms).writeAll) {
          diagnostics.push({
            checkId: "GHA033",
            severity: "warning",
            message: `Job "${job}" declares permissions: write-all — replace it with the specific scopes this job needs (least privilege).`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
