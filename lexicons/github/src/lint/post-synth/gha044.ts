/**
 * GHA044: Hardcoded Registry / Container Credential
 *
 * Flags a `password:` / `token:` / `registry-password:` value that is a literal
 * rather than a `${{ secrets.* }}` reference — e.g. a registry login or service
 * credential inlined in plain text. Move it into a secret.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobLines } from "./yaml-helpers";

const CRED_KEY_RE = /^\s+(?:- )?(password|token|registry-password):\s*(.+)$/;

export const gha044: PostSynthCheck = {
  id: "GHA044",
  description: "Hardcoded registry/container credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, line } of jobLines(yaml)) {
        const m = line.match(CRED_KEY_RE);
        if (!m) continue;
        const key = m[1];
        const value = m[2].trim().replace(/^['"]|['"]$/g, "");
        if (value === "" || value.includes("${{")) continue; // empty or a proper expression
        diagnostics.push({
          checkId: "GHA044",
          severity: "error",
          message: `Job "${job}" sets ${key}: to a hardcoded literal. Reference a secret (\${{ secrets.NAME }}) instead of inlining the credential.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
