/**
 * GHA053: Re-enabling Unsafe Workflow-Command Processing
 *
 * Flags opt-ins that reintroduce the `set-env` / `add-path` workflow commands
 * removed for security (CVE-2020-15228) — `ACTIONS_ALLOW_UNSECURE_COMMANDS` and
 * direct `::set-env::` / `::add-path::` emission. These let a logged string set
 * arbitrary environment/PATH state for later steps, a code-execution path.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, linesByJob } from "./yaml-helpers";

const UNSAFE_COMMANDS = /ACTIONS_ALLOW_UNSECURE_COMMANDS|::set-env\s|::add-path\s/;

export const gha053: PostSynthCheck = {
  id: "GHA053",
  description: "Re-enables unsafe set-env / add-path workflow commands",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const [job, lines] of linesByJob(yaml)) {
        if (lines.some((l) => UNSAFE_COMMANDS.test(l)) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "GHA053",
            severity: "error",
            message: `Job "${job}" re-enables the unsafe set-env/add-path workflow commands (ACTIONS_ALLOW_UNSECURE_COMMANDS or ::set-env::/::add-path::). Use $GITHUB_ENV / $GITHUB_PATH files instead — the legacy commands were removed for security.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
