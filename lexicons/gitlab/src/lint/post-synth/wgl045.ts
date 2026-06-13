/**
 * WGL045: Credential-Bearing Artifact Path
 *
 * Flags an `artifacts:paths:` entry that looks like it would sweep a credential
 * or sensitive file into the artifact (`.env`, `*.pem`, `id_rsa`, `*.key`,
 * `.npmrc`, `.netrc`, `credentials`). Artifacts flow to later stages and are
 * downloadable, so a captured credential leaks across the boundary. Exclude the
 * sensitive file from the artifact path.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection } from "./yaml-helpers";

const CREDENTIAL_PATH = /(^|\/)(\.env(\.|$)|\.npmrc|\.netrc|id_rsa|.*\.pem|.*\.key|.*\.p12|credentials?(\.|$))/i;

export const wgl045: PostSynthCheck = {
  id: "WGL045",
  description: "Artifact path that may capture a credential file",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        // Collect the lines under the artifacts: block (deeper indent than the key).
        const lines = section.split("\n");
        const artifactsIdx = lines.findIndex((l) => /^\s+artifacts:\s*$/.test(l));
        if (artifactsIdx === -1) continue;
        const artifactsIndent = lines[artifactsIdx].search(/\S/);
        const blockLines: string[] = [];
        for (let i = artifactsIdx + 1; i < lines.length; i++) {
          if (lines[i].trim() === "") continue;
          if (lines[i].search(/\S/) <= artifactsIndent) break;
          blockLines.push(lines[i]);
        }
        const hit = blockLines
          .filter((l) => /^\s+-\s+/.test(l))
          .map((l) => l.replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, ""))
          .find((p) => CREDENTIAL_PATH.test(p));
        if (hit) {
          diagnostics.push({
            checkId: "WGL045",
            severity: "error",
            message: `Job "${job}" includes a credential-like file ("${hit}") in its artifacts. Exclude it — artifacts are passed downstream and are downloadable.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
