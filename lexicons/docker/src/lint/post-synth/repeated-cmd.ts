/**
 * DKRD015: More than one CMD or ENTRYPOINT in a stage
 *
 * Only the last CMD and the last ENTRYPOINT of a stage take effect; the
 * earlier ones are silently ignored.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, instrText, stageLabel } from "./docker-helpers";

export const dkrd015: PostSynthCheck = {
  id: "DKRD015",
  description: "More than one CMD or ENTRYPOINT in a stage — only the last one takes effect",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        for (const kw of ["CMD", "ENTRYPOINT"]) {
          const all = stage.instructions.filter((i) => i.instruction === kw);
          if (all.length < 2) continue;
          diagnostics.push({
            checkId: "DKRD015",
            severity: "warning",
            message: `${fileName} ${stageLabel(stage)}: ${all.length} ${kw} instructions; only the last (${instrText(all[all.length - 1]!)}) takes effect. Remove the others.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
