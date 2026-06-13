/**
 * WGL040: Hardcoded Credential in a Registry Login
 *
 * Flags a `docker login` (or compatible) in a `script:` that passes a literal
 * password via `-p` / `--password` instead of a variable or `--password-stdin`.
 * An inlined credential sits in the committed pipeline and the job log. Use a
 * masked CI/CD variable and `--password-stdin`. Extends WGL016 to scripts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractScriptCommands } from "./yaml-helpers";

// docker/podman/buildah/helm login with -p/--password followed by a non-variable literal
const LITERAL_LOGIN = /\b(?:docker|podman|buildah|helm|crane|skopeo)\b[^\n]*\blogin\b[^\n]*(?:-p|--password)[=\s]+(?!["']?\$)["']?[^\s"']+/i;

export const wgl040: PostSynthCheck = {
  id: "WGL040",
  description: "Hardcoded credential in a registry login command",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, command } of extractScriptCommands(yaml)) {
        if (LITERAL_LOGIN.test(command) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "WGL040",
            severity: "error",
            message: `Job "${job}" passes a hardcoded password to a registry login. Use a masked CI/CD variable with --password-stdin instead of inlining the credential.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
