/**
 * WGL047: Software Fetched and Executed at Runtime Without Verification
 *
 * Flags a `script:` command that pipes a network download straight into a shell
 * (`curl ... | bash`, `wget ... | sh`). The fetched script is unpinned and
 * unverified, so whoever controls the URL controls what runs in the job.
 * Download to a file, verify a checksum/signature, then execute it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractScriptCommands } from "./yaml-helpers";

const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i;

export const wgl047: PostSynthCheck = {
  id: "WGL047",
  description: "Software fetched and piped to a shell without verification",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, command } of extractScriptCommands(yaml)) {
        if (PIPE_TO_SHELL.test(command) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "WGL047",
            severity: "warning",
            message: `Job "${job}" pipes a network download directly into a shell — the fetched code is unpinned and unverified. Download to a file, verify a checksum or signature, then execute it.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
