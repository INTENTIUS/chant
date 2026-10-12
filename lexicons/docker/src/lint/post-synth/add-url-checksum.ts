/**
 * DKRD019: ADD of a remote URL without --checksum
 *
 * ADD fetches an http(s) URL at build time and trusts whatever comes back.
 * `ADD --checksum=sha256:...` makes the build fail when the content changes.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, stageLabel } from "./docker-helpers";

export const dkrd019: PostSynthCheck = {
  id: "DKRD019",
  description: "ADD fetches a remote URL without --checksum",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        for (const instr of stage.instructions) {
          if (instr.instruction !== "ADD") continue;
          const words = instr.value.split(/\s+/);
          if (words.some((w) => w.startsWith("--checksum="))) continue;
          const url = words.find((w) => /^https?:\/\//i.test(w));
          if (!url) continue;
          diagnostics.push({
            checkId: "DKRD019",
            severity: "warning",
            message: `${fileName} ${stageLabel(stage)}: ADD ${url} has no --checksum, so the build accepts whatever the URL serves. Add --checksum=sha256:<digest>.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
