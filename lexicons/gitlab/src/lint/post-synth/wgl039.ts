/**
 * WGL039: Secret Echoed to Job Logs
 *
 * Flags a `script:` command that prints a secret-like variable (`echo`,
 * `printf`, `print`, `cat`) — even masked variables leak when transformed
 * (base64, reversed) before printing, and job logs are broadly readable.
 * Remove the debug print or pipe the value where it is needed without echoing it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractScriptCommands } from "./yaml-helpers";

const PRINT_SECRET = /\b(echo|printf|print|cat)\b[^\n]*\$\{?[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)\}?/i;

export const wgl039: PostSynthCheck = {
  id: "WGL039",
  description: "Secret-like variable printed to job logs",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, command } of extractScriptCommands(yaml)) {
        if (PRINT_SECRET.test(command) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "WGL039",
            severity: "warning",
            message: `Job "${job}" prints a secret-like variable to the job log. Logs are broadly readable and masking can be defeated by transforms — remove the print.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
