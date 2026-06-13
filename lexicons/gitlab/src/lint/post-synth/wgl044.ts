/**
 * WGL044: Public Artifacts
 *
 * Flags `artifacts:public: true`. Public artifacts are downloadable by anyone,
 * including unauthenticated users for public projects, exposing build output and
 * anything swept into it. Keep artifacts private unless they are deliberately
 * meant to be world-readable.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection } from "./yaml-helpers";

const PUBLIC_ARTIFACTS = /^\s+public:\s*true\s*$/m;

export const wgl044: PostSynthCheck = {
  id: "WGL044",
  description: "Public artifacts expose build output",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section || !/^\s+artifacts:/m.test(section)) continue;
        if (PUBLIC_ARTIFACTS.test(section)) {
          diagnostics.push({
            checkId: "WGL044",
            severity: "warning",
            message: `Job "${job}" publishes public artifacts (artifacts:public: true), downloadable by anyone. Keep them private unless they are meant to be world-readable.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
