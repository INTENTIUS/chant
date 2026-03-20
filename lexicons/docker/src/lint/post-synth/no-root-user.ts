/**
 * DKRD012: No Root User
 *
 * Warns when a Dockerfile has no USER instruction,
 * meaning the container runs as root by default.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { extractDockerfiles } from "./docker-helpers";

export const dkrd012: PostSynthCheck = {
  id: "DKRD012",
  description: "Dockerfile has no USER instruction — container runs as root",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const dockerfiles = extractDockerfiles(output);

      for (const [fileName, content] of dockerfiles) {
        const hasUser = /^USER\s+/m.test(content);
        if (!hasUser) {
          diagnostics.push({
            checkId: "DKRD012",
            severity: "warning",
            message: `${fileName}: No USER instruction found. The container will run as root. Add a USER instruction to improve security.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
