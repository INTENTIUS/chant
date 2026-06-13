/**
 * WGL035: Untrusted CI Variable Interpolated into a Script
 *
 * Flags an attacker-controllable predefined variable (branch/tag name, commit or
 * merge-request title/description, author) referenced in a `script:` command. A
 * crafted branch name or commit title containing shell metacharacters can break
 * out of the command. Quote the reference and avoid using it in sensitive
 * commands, or sanitize it first.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractScriptCommands } from "./yaml-helpers";
import { UNTRUSTED_CI_VARIABLES, variableReferenced } from "../rules/data/untrusted-variables";

export const wgl035: PostSynthCheck = {
  id: "WGL035",
  description: "Untrusted CI variable interpolated into a script command",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, command } of extractScriptCommands(yaml)) {
        for (const name of UNTRUSTED_CI_VARIABLES) {
          if (!variableReferenced(command, name)) continue;
          const key = `${job}:${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          diagnostics.push({
            checkId: "WGL035",
            severity: "warning",
            message: `Job "${job}" uses the attacker-controllable variable $${name} in a script command. A crafted value can inject shell commands — quote it ("$${name}") and avoid using it in sensitive commands, or sanitize it first.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
