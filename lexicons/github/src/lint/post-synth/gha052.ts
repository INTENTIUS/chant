/**
 * GHA052: Software Fetched and Executed at Runtime Without Verification
 *
 * Flags a `run:` step that pipes a network download straight into a shell
 * (`curl ... | bash`, `wget ... | sh`, `iwr ... | iex`). The fetched script is
 * unpinned and unverified, so whoever controls the URL controls what executes
 * in the job. Download to a file, verify a checksum/signature, then run it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunBlocks } from "./yaml-helpers";

const PIPE_TO_SHELL = [
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\b(iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(iex|invoke-expression)\b/i,
];

export const gha052: PostSynthCheck = {
  id: "GHA052",
  description: "Software fetched and piped to a shell without verification",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, run } of extractRunBlocks(yaml)) {
        if (PIPE_TO_SHELL.some((re) => re.test(run))) {
          diagnostics.push({
            checkId: "GHA052",
            severity: "warning",
            message: `Job "${job}" pipes a network download directly into a shell — the fetched code is unpinned and unverified. Download to a file, verify a checksum or signature, then execute it.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
