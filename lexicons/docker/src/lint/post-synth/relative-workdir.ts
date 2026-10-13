/**
 * DKRD018: Relative WORKDIR
 *
 * A relative WORKDIR resolves against whatever directory the base image
 * left, which can change with the image. Use an absolute path, at least for
 * the first WORKDIR of a stage.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, stageLabel } from "./docker-helpers";

export const dkrd018: PostSynthCheck = {
  id: "DKRD018",
  description: "Relative WORKDIR before any absolute WORKDIR in the stage",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        for (const instr of stage.instructions) {
          if (instr.instruction !== "WORKDIR") continue;
          const dir = instr.value.trim().replace(/^["']|["']$/g, "");
          if (dir.startsWith("/") || dir.startsWith("$") || /^[A-Za-z]:[\\/]/.test(dir)) break;
          diagnostics.push({
            checkId: "DKRD018",
            severity: "warning",
            message: `${fileName} ${stageLabel(stage)}: WORKDIR ${dir} is relative to the base image's working directory. Use an absolute path.`,
            lexicon: "docker",
          });
          break;
        }
      }
    }

    return diagnostics;
  },
};
