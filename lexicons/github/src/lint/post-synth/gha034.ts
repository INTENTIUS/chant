/**
 * GHA034: Workflow-Wide Write Scope (Prefer Job-Scoped Permissions)
 *
 * Flags individual write scopes granted at the workflow level. A workflow-wide
 * grant gives every job that scope even when only one needs it. Least privilege
 * prefers declaring the write scope on the single job that uses it.
 *
 * The `write-all` blanket preset is handled by GHA033 and skipped here.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractWorkflowPermissions, writeSurface } from "./yaml-helpers";

export const gha034: PostSynthCheck = {
  id: "GHA034",
  description: "Write permissions granted workflow-wide instead of per-job",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const wf = extractWorkflowPermissions(yaml);
      if (!wf) continue;

      const { writeAll, scopes } = writeSurface(wf);
      if (writeAll) continue; // GHA033 owns write-all
      if (scopes.length === 0) continue;

      diagnostics.push({
        checkId: "GHA034",
        severity: "warning",
        message: `Workflow grants write scope (${scopes.join(", ")}) for all jobs — move each write scope onto the specific job that needs it for least privilege.`,
        lexicon: "github",
      });
    }

    return diagnostics;
  },
};
