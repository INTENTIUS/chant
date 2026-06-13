/**
 * WGL037: Security Gate on a Regex Match of an Untrusted Ref
 *
 * Flags a `rules:if` that gates execution on a regex match (`=~`) over an
 * attacker-controllable ref variable (e.g. `$CI_COMMIT_REF_NAME =~ /^release/`).
 * An outside contributor can craft a branch name that satisfies the pattern
 * (`release-evil`), passing a gate meant for trusted refs. Match the full ref
 * with `==`, or gate on a protected condition instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection } from "./yaml-helpers";
import { UNTRUSTED_CI_VARIABLES } from "../rules/data/untrusted-variables";

const REF_VARS = ["CI_COMMIT_REF_NAME", "CI_COMMIT_REF_SLUG", "CI_COMMIT_BRANCH", "CI_COMMIT_TAG", "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"]
  .filter((v) => UNTRUSTED_CI_VARIABLES.includes(v));

export const wgl037: PostSynthCheck = {
  id: "WGL037",
  description: "Security gate on a regex match of an untrusted ref variable",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        // Look at `if:` lines that use a regex match against an untrusted ref var.
        const ifLines = section.split("\n").filter((l) => /if:\s/.test(l));
        const flagged = ifLines.some((l) => /=~/.test(l) && REF_VARS.some((v) => l.includes(`$${v}`)));
        if (flagged) {
          diagnostics.push({
            checkId: "WGL037",
            severity: "warning",
            message: `Job "${job}" gates on a regex match (=~) of an attacker-controllable ref variable. A crafted branch/tag name can satisfy the pattern — match the full ref with == or gate on a protected condition.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
