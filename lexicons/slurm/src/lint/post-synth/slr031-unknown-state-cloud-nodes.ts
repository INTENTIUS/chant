/**
 * SLR031: Node has State=UNKNOWN when SuspendProgram is configured
 *
 * When a cluster uses SuspendProgram/ResumeProgram (cloud bursting), nodes
 * that should be cloud-managed must have State=CLOUD — not State=UNKNOWN.
 *
 * UNKNOWN nodes are treated as dead/unreachable by slurmctld. The suspend/resume
 * cycle only applies to CLOUD nodes. An UNKNOWN node will never be resumed when
 * a job requests it — the job queues indefinitely.
 *
 * This fires when SuspendProgram is set in slurm.conf AND any NodeName= stanza
 * has State=UNKNOWN. Change those nodes to State=CLOUD.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

const nodeUnknownRe = /^NodeName=(\S+)\s[^\n]*State=UNKNOWN/gm;

export function checkUnknownStateCloudNodes(content: string): PostSynthDiagnostic[] {
  const hasSuspendProgram = /^SuspendProgram=/m.test(content);
  if (!hasSuspendProgram) return [];

  const diagnostics: PostSynthDiagnostic[] = [];
  let match: RegExpExecArray | null;

  while ((match = nodeUnknownRe.exec(content)) !== null) {
    diagnostics.push({
      checkId: "SLR031",
      severity: "warning",
      message:
        `Node "${match[1]}" has State=UNKNOWN but SuspendProgram is configured. ` +
        "UNKNOWN nodes are not eligible for cloud suspend/resume — change State to CLOUD.",
      lexicon: "slurm",
    });
  }

  return diagnostics;
}

export const slr031: PostSynthCheck = {
  id: "SLR031",
  description: "Node has State=UNKNOWN when SuspendProgram is configured — should be State=CLOUD",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : (output as { primary: string }).primary;
      diagnostics.push(...checkUnknownStateCloudNodes(content));
    }

    return diagnostics;
  },
};
