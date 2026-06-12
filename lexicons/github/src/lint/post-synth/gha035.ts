/**
 * GHA035: Elevated Token Scope on an Untrusted-Code Trigger
 *
 * Raises the stakes of GHA033/GHA034: when a workflow can run untrusted code
 * (`pull_request_target`, `workflow_run`) and also grants the token write
 * access, an injected step runs with standing write credentials. This is the
 * combination behind most CI privilege-escalation incidents, so it is an error.
 *
 * Cross-references the trust-boundary checks (GHA018 / GHA025 / GHA038).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  getPrimaryOutput,
  extractTriggers,
  extractWorkflowPermissions,
  extractJobPermissions,
  writeSurface,
  grantsWrite,
} from "./yaml-helpers";

const UNTRUSTED_TRIGGERS = ["pull_request_target", "workflow_run"];

function describeWrite(perms: ReturnType<typeof writeSurface>): string {
  return perms.writeAll ? "write-all" : perms.scopes.map((s) => `${s}: write`).join(", ");
}

export const gha035: PostSynthCheck = {
  id: "GHA035",
  description: "Elevated token scope on a trigger that can run untrusted code",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);
      const untrusted = UNTRUSTED_TRIGGERS.filter((t) => triggers[t]);
      if (untrusted.length === 0) continue;

      const wf = extractWorkflowPermissions(yaml);
      if (wf && grantsWrite(wf)) {
        diagnostics.push({
          checkId: "GHA035",
          severity: "error",
          message: `Workflow grants write token scope (${describeWrite(writeSurface(wf))}) while using the ${untrusted.join("/")} trigger, which can run untrusted code. Drop write scope or gate the privileged work behind a separate trusted workflow.`,
          lexicon: "github",
        });
      }

      for (const [job, perms] of extractJobPermissions(yaml)) {
        if (grantsWrite(perms)) {
          diagnostics.push({
            checkId: "GHA035",
            severity: "error",
            message: `Job "${job}" grants write token scope (${describeWrite(writeSurface(perms))}) while the workflow uses the ${untrusted.join("/")} trigger, which can run untrusted code. Drop write scope or isolate the privileged work.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
