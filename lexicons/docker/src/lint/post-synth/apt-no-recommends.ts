/**
 * DKRD010: apt-get install without --no-install-recommends
 *
 * Detects RUN instructions with apt-get install missing
 * --no-install-recommends, which leads to bloated images.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { extractDockerfiles } from "./docker-helpers";

export const dkrd010: PostSynthCheck = {
  id: "DKRD010",
  description: "apt-get install without --no-install-recommends adds unnecessary packages",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const dockerfiles = extractDockerfiles(output);

      for (const [fileName, content] of dockerfiles) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (
            /^RUN\s+/.test(line) &&
            line.includes("apt-get install") &&
            !line.includes("--no-install-recommends")
          ) {
            diagnostics.push({
              checkId: "DKRD010",
              severity: "warning",
              message: `${fileName}: RUN apt-get install should use --no-install-recommends to reduce image size.`,
              lexicon: "docker",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
